use std::collections::{BTreeMap, BTreeSet};

use poietra_geometry::align_cubic_path_morph_chain;
use poietra_scene_ir::{
    AffineTransformV1, AnimationChannelV1, AssetReferenceV1, ContractVersionV1, CubicPathV1,
    EasingV1, FidelityV1, FillRuleV1, FillStyleV1, FragmentMaterialV1, ImageLocalRectV1,
    ImageSamplerV1, IntervalV1, KeyframeV1, MAX_COORDINATE_V1, PathTrimParameterizationV1, PointV1,
    ProvenanceOriginV1, ProvenanceRecordV1, RgbaColorV1, SceneAppearanceV1, SceneCameraViewV1,
    SceneCapabilityV1, SceneEntityV1, SceneGeometryV1, SceneIrBundleV1, SceneSourceV1, StrokeCapV1,
    VectorAppearanceValueV1,
};
use serde::{Deserialize, Serialize};
use unicode_normalization::is_nfc;

use crate::{EngineSessionV1, EvaluationError};

mod geometry;
mod materialization;
mod planning;

#[cfg(test)]
use geometry::straight_cubic_segment;
use geometry::{
    created_geometry_and_appearance, scale_cubic_path, studio_arc_parameters, studio_arc_path,
    studio_coordinate_system_parameters, studio_coordinate_system_path,
    studio_cubic_bezier_appearance, studio_data_plot_path, studio_data_series_is_valid,
    studio_ellipse_parameters, studio_ellipse_path, studio_regular_polygon_parameters,
    studio_regular_polygon_path, studio_sector_path, studio_shape_transform_path,
};
use planning::{canonical_studio_hex_color, plan_studio_creation_edits};
#[cfg(test)]
use poietra_scene_ir::CubicSubpathV1;

use super::cubic_bezier::{
    NormalizedStudioCubicBezier, StudioCreationCubicBezierSpec, StudioCubicBezierStrokeCap,
    normalize_studio_cubic_bezier, studio_cubic_bezier_dimensions_are_canonical,
    studio_cubic_bezier_is_canonical,
};
use super::motion::{
    ApplyStudioMotionEditError, PlannedSceneMotion, PlannedStudioMotion, StudioMotionEasing,
    StudioMotionPlan, StudioMotionProjection, StudioMotionProjectionInsertion,
    StudioMotionProjectionTarget, StudioProjectedMotion, append_planned_scene_motions,
    authored_motion_easing, motion_easing, project_studio_motion_plan,
};
use super::presence::{PersistentSceneRemoval, apply_persistent_scene_removals};
use super::svg_path::{NormalizedStudioSvgPathAsset, normalize_studio_svg_path_asset};
use super::timeline::{
    SceneTimelineInsertion, StudioTimelineEditInput, StudioTimelineEditProjection,
    StudioTimelineEditTransform, StudioTimelineEventKind, StudioTimelineOperation,
    StudioTimelinePlanningState, StudioTimelineProjection, StudioTimelinePurpose,
    insert_scene_time, shift_interval_for_insertion, time_after_removal,
    validate_studio_timeline_edits,
};
use super::transform::{apply_world_rotation, rotation_is_noop, set_vector_paint_alpha};
use super::{
    ApplyStudioPersistentRemoveError, SceneEditAnchorSource, SceneEditExecution,
    SceneEditOperationFacts, SceneEditScheduleMode, StudioAuthoringAngles,
    StudioAuthoringCoordinateRange, StudioAuthoringCoordinateSystem, StudioAuthoringDimensions,
    StudioAuthoringEditResult, StudioAuthoringEntityKind, StudioAuthoringOrigin,
    StudioAuthoringSize, StudioCreationMathTexOutline, StudioCreationSegmentedMathTexFragment,
    StudioCreationSegmentedMathTexOutline, StudioCreationSegmentedMathTexRepresentation,
    StudioCreationSegmentedMathTexSourceCorrelation,
    StudioCreationSegmentedMathTexSourceCorrelationKind, StudioCreationSegmentedMathTexWritePlan,
    StudioCreationTextOutline, StudioMathTexContent, StudioMathTexTransformStrategy,
    StudioPersistentRemoveProjection, StudioPersistentRemoveProjectionEntry, StudioTextContent,
    StudioTextLayout, TIMELINE_ANCHOR_EPSILON, close_transform_baseline_value,
    scene_edit_anchor_is_closed, scene_edit_structure_is_closed, studio_arrow_appearance,
    studio_authoring_point_is_finite, studio_authoring_shape_size,
    studio_authoring_size_is_positive, studio_math_tex_appearance,
    studio_math_tex_content_is_canonical, studio_point_to_scene_point, studio_shape_appearance,
    studio_timeline_semantic_values_match, studio_vector_to_scene_vector, unused_channel_id,
};

#[derive(Clone, Debug, PartialEq)]
enum CreateSceneEntityGeometry {
    Arrow,
    Circle {
        radius: f64,
    },
    CubicBezier {
        appearance: SceneAppearanceV1,
        path: CubicPathV1,
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
    TextOutline {
        path: CubicPathV1,
    },
    ShapeOutline {
        path: CubicPathV1,
    },
    SvgPath {
        appearance: SceneAppearanceV1,
        path: CubicPathV1,
    },
    LogicalGroup,
}

#[derive(Clone, Debug, PartialEq)]
struct CreateSceneEntityFadeIn {
    end: f64,
}

#[derive(Clone, Debug, PartialEq)]
struct CreateSceneEntityDrawIn {
    easing: EasingV1,
    end: f64,
}

#[derive(Clone, Debug, PartialEq)]
struct CreateSceneEntityWriteIn {
    easing: EasingV1,
    interval: IntervalV1,
    fragments: Vec<StudioCreationSegmentedMathTexFragment>,
    plan: StudioCreationSegmentedMathTexWritePlan,
    source: String,
}

#[derive(Clone, Debug, PartialEq)]
struct CreateSceneEntityMathTexMorph {
    initial_path: CubicPathV1,
    keyframes: Vec<KeyframeV1<CubicPathV1>>,
    start: f64,
}

#[derive(Clone, Debug, PartialEq)]
struct CreateSceneEntityShapeMorph {
    initial_path: CubicPathV1,
    keyframes: Vec<KeyframeV1<CubicPathV1>>,
}

const SEGMENTED_MATH_TEX_MAX_FRAGMENTS: usize = 128;
const SEGMENTED_MATH_TEX_MAX_CUBIC_SEGMENTS: usize = 2_048;
const SEGMENTED_MATH_TEX_MAX_SOURCE_BYTES: usize = 256;
const SEGMENTED_MATH_TEX_PHASE_BOUNDARY: f64 = 0.5;
const SEGMENTED_MATH_TEX_OUTLINE_STROKE_WIDTH: f64 = 2.0;
const MANIM_STROKE_WIDTH_TO_SCENE_WORLD: f64 = 0.01;
const MIN_STUDIO_STROKE_WIDTH_WORLD: f64 = 0.005;
const MAX_STUDIO_STROKE_WIDTH_WORLD: f64 = 0.5;

fn manim_stroke_width_to_scene_world(width: f64) -> f64 {
    width * MANIM_STROKE_WIDTH_TO_SCENE_WORLD
}

fn studio_creation_supports_stroke_width(kind: StudioAuthoringEntityKind) -> bool {
    matches!(
        kind,
        StudioAuthoringEntityKind::Circle
            | StudioAuthoringEntityKind::Ellipse
            | StudioAuthoringEntityKind::Line
            | StudioAuthoringEntityKind::Rectangle
            | StudioAuthoringEntityKind::RegularPolygon
    )
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StudioPaintColorProperty {
    FillColor,
    StrokeColor,
}

#[derive(Clone, Debug, PartialEq)]
struct StudioPaintColorTrack {
    keyframes: Vec<KeyframeV1<RgbaColorV1>>,
    property: StudioPaintColorProperty,
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
struct CreateSceneEntityAnimatedResize {
    interval: IntervalV1,
    from: AffineTransformV1,
    to: AffineTransformV1,
}

#[derive(Clone, Debug, PartialEq)]
struct CreateSceneEntity {
    animated_resize: Option<CreateSceneEntityAnimatedResize>,
    appearance_at: Option<f64>,
    draw_in: Option<CreateSceneEntityDrawIn>,
    fade_in: Option<CreateSceneEntityFadeIn>,
    fill_color: Option<RgbaColorV1>,
    geometry: CreateSceneEntityGeometry,
    id: String,
    lifetime: IntervalV1,
    material_parameter_keyframes: Vec<KeyframeV1<FragmentMaterialV1>>,
    math_tex_morph: Option<CreateSceneEntityMathTexMorph>,
    opacity_keyframes: Vec<KeyframeV1<f64>>,
    paint_color_track: Option<StudioPaintColorTrack>,
    paint_opacity: f64,
    position: PointV1,
    rotation: f64,
    rotation_keyframes: Vec<KeyframeV1<f64>>,
    scale: f64,
    uniform_scale_keyframes: Vec<KeyframeV1<f64>>,
    source_z_index: Option<f64>,
    shape_morph: Option<CreateSceneEntityShapeMorph>,
    stroke_color: Option<RgbaColorV1>,
    stroke_cap: Option<StrokeCapV1>,
    stroke_width_world: Option<f64>,
    instant_transform: Option<CreateSceneEntityInstantTransform>,
    visible: bool,
    write_in: Option<CreateSceneEntityWriteIn>,
}

#[derive(Clone, Debug, PartialEq)]
struct CreateSceneEntitiesCommand {
    camera_animation: Option<PlannedStudioCameraAnimation>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cubic_bezier: Option<StudioCreationCubicBezierSpec>,
    pub created_lifetime: IntervalV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_series: Option<StudioDataSeries>,
    pub entity_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill_color: Option<String>,
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
    pub stroke_color: Option<String>,
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

/// One bounded SVG source admitted and normalized exclusively by the Rust core.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationSvgPathSpec {
    pub source: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StudioDataPlotInterpolation {
    Linear,
    Smooth,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioDataSeries {
    pub interpolation: StudioDataPlotInterpolation,
    pub points: Vec<PointV1>,
}

/// One exact property mutation resolved by the shared creation planner.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum StudioCreationProjectedMutationKind {
    AnimateCamera {
        easing: EasingV1,
        from_view: SceneCameraViewV1,
        to_view: SceneCameraViewV1,
    },
    Position {
        value: PointV1,
    },
    FadeIn {
        from: f64,
        to: f64,
    },
    DrawIn {
        easing: EasingV1,
        from: f64,
        to: f64,
    },
    WriteIn {
        easing: EasingV1,
        from: f64,
        to: f64,
    },
    MathTexTransform {
        content: StudioMathTexContent,
        easing: EasingV1,
        source_entity_id: String,
        target_entity_id: String,
    },
    ShapeTransform {
        easing: EasingV1,
        from_dimensions: StudioAuthoringDimensions,
        from_shape: StudioAuthoringEntityKind,
        to_dimensions: StudioAuthoringDimensions,
        to_shape: StudioAuthoringEntityKind,
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
    PaintColorKeyframes {
        easing: EasingV1,
        from: String,
        property: StudioPaintColorProperty,
        to: String,
    },
    StrokeCap {
        value: StrokeCapV1,
    },
    StrokeWidth {
        value: f64,
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
    #[serde(skip_serializing_if = "String::is_empty")]
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
    /// Wait operation IDs beyond which a duration trim cannot cross because a
    /// positive-duration authoring insertion follows at the same source anchor.
    pub duration_trim_barrier_operation_ids: Vec<String>,
    pub entities: Vec<StudioProjectedCreationEntity>,
    pub insertions: Vec<StudioMotionProjectionInsertion>,
    pub motions: Vec<StudioProjectedMotion>,
    pub mutations: Vec<StudioCreationProjectedMutation>,
    pub projected_duration: f64,
    pub removals: Vec<StudioPersistentRemoveProjectionEntry>,
    /// Duration Programs on their duration-only working axis. Its projected
    /// duration remains the final duration of the complete creation batch.
    pub timeline_projection: StudioTimelineProjection,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationEntitySpec {
    #[serde(default)]
    pub cubic_bezier: Option<StudioCreationCubicBezierSpec>,
    #[serde(default)]
    pub data_series: Option<StudioDataSeries>,
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
    #[serde(default)]
    pub svg: Option<StudioCreationSvgPathSpec>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct StudioCreationShapeState {
    dimensions: StudioAuthoringDimensions,
    kind: StudioAuthoringEntityKind,
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
    DrawIn {
        easing: StudioPropertyEasing,
        from: Option<f64>,
        to: Option<f64>,
    },
    WriteIn {
        easing: StudioPropertyEasing,
    },
    TransformContent {
        easing: StudioPropertyEasing,
        replacement: StudioMathTexContent,
        source_entity_id: String,
        strategy: StudioMathTexTransformStrategy,
        target_entity_id: String,
        target_type: Option<String>,
    },
    #[serde(rename = "shape-transform")]
    TransformShape {
        easing: StudioPropertyEasing,
        from_dimensions: StudioAuthoringDimensions,
        from_shape: StudioAuthoringEntityKind,
        to_dimensions: StudioAuthoringDimensions,
        to_shape: StudioAuthoringEntityKind,
    },
    AnimateCamera {
        easing: StudioPropertyEasing,
        from_view: SceneCameraViewV1,
        to_view: SceneCameraViewV1,
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
    PaintColorKeyframes {
        easing: StudioPropertyEasing,
        from: Option<String>,
        property: StudioPaintColorProperty,
        to: Option<String>,
    },
    StrokeCap {
        cap: Option<StrokeCapV1>,
    },
    StrokeWidth {
        width_world: Option<f64>,
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
        #[serde(default)]
        orient_to_path: bool,
        #[serde(default)]
        rotation_delta_radians: Option<f64>,
        target_entity_ids: Vec<String>,
    },
    Group {
        child_entity_ids: Vec<String>,
        group_id: String,
    },
    Ungroup {
        group_id: String,
    },
    InsertWait {
        event_kind: StudioTimelineEventKind,
        purpose: Option<StudioTimelinePurpose>,
    },
    TrimSceneDuration {
        removed_duration: f64,
        target_duration: f64,
        wait_operation_ids: Vec<String>,
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
    pub segmented_math_tex_outlines: Vec<StudioCreationSegmentedMathTexOutline>,
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
    #[error("a Studio creation command must contain an entity or camera animation")]
    EmptyBatch,
    #[error("the Studio camera animation does not match the base Scene camera contract")]
    InvalidCameraAnimation,
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
    #[error("the Studio cubic Bézier is unsupported: {0}")]
    CubicBezier(#[from] super::StudioCubicBezierError),
    #[error("the Studio SVG path asset is unsupported: {0}")]
    SvgPath(#[from] super::StudioSvgPathError),
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
            | StudioCreationOperationKind::UniformScaleKeyframes { .. }
            | StudioCreationOperationKind::RotationKeyframes { .. }
            | StudioCreationOperationKind::FillColor { .. }
            | StudioCreationOperationKind::StrokeColor { .. }
            | StudioCreationOperationKind::PaintColorKeyframes { .. }
            | StudioCreationOperationKind::StrokeCap { .. }
            | StudioCreationOperationKind::StrokeWidth { .. }
            | StudioCreationOperationKind::Resize { .. }
            | StudioCreationOperationKind::PersistentRemove { .. }
            | StudioCreationOperationKind::CreateMotion { .. }
            | StudioCreationOperationKind::Group { .. }
            | StudioCreationOperationKind::Ungroup { .. }
            | StudioCreationOperationKind::InsertWait { .. }
            | StudioCreationOperationKind::TrimSceneDuration { .. }
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
    animated_resize: Option<PlannedStudioAnimatedResize>,
    appearance_at: Option<f64>,
    create_operation_id: String,
    creation_transaction_id: String,
    creation_program_rank: usize,
    cubic_bezier: Option<NormalizedStudioCubicBezier>,
    current_dimensions: StudioAuthoringDimensions,
    current_shape: Option<StudioCreationShapeState>,
    current_text_content: Option<StudioTextContent>,
    fill_color_override: Option<String>,
    current_opacity: f64,
    current_rotation: f64,
    draw_easing: Option<EasingV1>,
    draw_interval: Option<IntervalV1>,
    stroke_color_override: Option<String>,
    stroke_cap_override: Option<StrokeCapV1>,
    stroke_width_world_override: Option<f64>,
    fade_interval: Option<IntervalV1>,
    initial_dimensions: StudioAuthoringDimensions,
    initial_position: PointV1,
    instant_at: Option<f64>,
    instant_rotation: f64,
    has_position_or_resize_instant: bool,
    kind: StudioAuthoringEntityKind,
    lifetime: IntervalV1,
    material_parameter_keyframes: Vec<KeyframeV1<FragmentMaterialV1>>,
    math_tex_transforms: Vec<PlannedStudioMathTexTransform>,
    opacity_keyframes: Vec<KeyframeV1<f64>>,
    paint_color_track: Option<StudioPaintColorTrack>,
    persistent_removal: Option<PersistentSceneRemoval>,
    position: PointV1,
    rotation_keyframes: Vec<KeyframeV1<f64>>,
    scale: f64,
    shape_path_dimensions: Option<StudioAuthoringDimensions>,
    shape_transforms: Vec<PlannedStudioShapeTransform>,
    uniform_scale_keyframes: Vec<KeyframeV1<f64>>,
    source_z_index: Option<f64>,
    spec: StudioCreationEntitySpec,
    svg_path: Option<NormalizedStudioSvgPathAsset>,
    visible: bool,
    write_easing: Option<EasingV1>,
    write_interval: Option<IntervalV1>,
}

#[derive(Clone, Debug, PartialEq)]
struct PlannedStudioAnimatedResize {
    from_dimensions: StudioAuthoringDimensions,
    from_position: PointV1,
    interval: IntervalV1,
    shape: StudioAuthoringEntityKind,
    to_dimensions: StudioAuthoringDimensions,
    to_position: PointV1,
}

#[derive(Clone, Debug, PartialEq)]
struct PlannedStudioMathTexTransform {
    content: StudioMathTexContent,
    easing: EasingV1,
    interval: IntervalV1,
    operation_id: String,
    source_entity_id: String,
    target_entity_id: String,
    transaction_id: String,
}

#[derive(Clone, Debug, PartialEq)]
struct PlannedStudioShapeTransform {
    easing: EasingV1,
    from: StudioCreationShapeState,
    interval: IntervalV1,
    operation_id: String,
    to: StudioCreationShapeState,
    transaction_id: String,
}

#[derive(Clone, Debug, PartialEq)]
struct PlannedStudioCameraClip {
    easing: EasingV1,
    from_view: SceneCameraViewV1,
    interval: IntervalV1,
    to_view: SceneCameraViewV1,
}

#[derive(Clone, Debug, PartialEq)]
struct PlannedStudioCameraAnimation {
    initial_view: SceneCameraViewV1,
    keyframes: Vec<KeyframeV1<SceneCameraViewV1>>,
}

struct StudioCreationTimelinePlan {
    duration_trim_barrier_operation_ids: Vec<String>,
    duration_program_indices: BTreeSet<usize>,
    insertions: Vec<StudioMotionProjectionInsertion>,
    offsets: Vec<f64>,
    ordered_programs: Vec<usize>,
    projected_duration: f64,
    ranked_insertions: Vec<(usize, SceneTimelineInsertion)>,
    ranks: Vec<usize>,
    timeline_projection: StudioTimelineProjection,
}

#[derive(Clone, Debug)]
struct RankedStudioCreationInsertion {
    projection: StudioMotionProjectionInsertion,
    rank: usize,
}

fn studio_creation_timeline_input(
    program: &StudioCreationEditInput,
) -> Result<Option<StudioTimelineEditInput>, ProjectStudioCreationEditError> {
    let duration_operation_count = program
        .operations
        .iter()
        .filter(|operation| {
            matches!(
                operation.kind,
                StudioCreationOperationKind::InsertWait { .. }
                    | StudioCreationOperationKind::TrimSceneDuration { .. }
            )
        })
        .count();
    if duration_operation_count == 0 {
        return Ok(None);
    }
    if duration_operation_count != 1 || program.operations.len() != 1 {
        return Err(ProjectStudioCreationEditError::Unsupported);
    }
    let operation = &program.operations[0];
    if operation.entity_id.is_some() {
        return Err(ProjectStudioCreationEditError::Unsupported);
    }
    let timeline_operation = match &operation.kind {
        StudioCreationOperationKind::InsertWait {
            event_kind,
            purpose,
        } => StudioTimelineOperation::InsertWait {
            depends_on: operation.depends_on.clone(),
            event_kind: *event_kind,
            id: operation.id.clone(),
            interval: operation.interval.clone(),
            origin: operation.origin,
            purpose: *purpose,
        },
        StudioCreationOperationKind::TrimSceneDuration {
            removed_duration,
            target_duration,
            wait_operation_ids,
        } => StudioTimelineOperation::TrimSceneDuration {
            depends_on: operation.depends_on.clone(),
            id: operation.id.clone(),
            interval: operation.interval.clone(),
            origin: operation.origin,
            removed_duration: *removed_duration,
            target_duration: *target_duration,
            wait_operation_ids: wait_operation_ids.clone(),
        },
        _ => return Err(ProjectStudioCreationEditError::Unsupported),
    };
    Ok(Some(StudioTimelineEditInput {
        anchor_captured_playhead: program.anchor_captured_playhead,
        anchor_resolved_seconds: program.anchor_resolved_seconds,
        anchor_source: program.anchor_source.clone(),
        intent_count: program.intent_count,
        lowering_supported: program.lowering_supported,
        operations: vec![timeline_operation],
        origin: program.origin,
        requested_execution: program.requested_execution,
        schedule_edge_count: program.schedule_edge_count,
        schedule_mode: program.schedule_mode,
        schedule_order: program.schedule_order.clone(),
        transaction_id: program.transaction_id.clone(),
    }))
}

fn remove_time_from_creation_insertions(
    insertions: &mut Vec<RankedStudioCreationInsertion>,
    removal: &IntervalV1,
) {
    for insertion in insertions.iter_mut() {
        let start = time_after_removal(insertion.projection.at, removal.start, removal.end);
        let end = time_after_removal(
            insertion.projection.at + insertion.projection.duration,
            removal.start,
            removal.end,
        );
        insertion.projection.at = start;
        let duration = (end - start).max(0.0);
        insertion.projection.duration = if studio_timeline_semantic_values_match(duration, 0.0) {
            0.0
        } else {
            duration
        };
    }
    insertions.retain(|insertion| insertion.projection.duration > 0.0);
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
                matches!(
                    operation.kind,
                    StudioCreationOperationKind::FadeIn { .. }
                        | StudioCreationOperationKind::DrawIn { .. }
                        | StudioCreationOperationKind::WriteIn { .. }
                )
            } else {
                matches!(
                    operation.kind,
                    StudioCreationOperationKind::CreateMotion { .. }
                        | StudioCreationOperationKind::TransformContent { .. }
                        | StudioCreationOperationKind::TransformShape { .. }
                        | StudioCreationOperationKind::AnimateCamera { .. }
                )
            }
        })
        .map(|operation| operation.interval.end)
        .fold(program.anchor_resolved_seconds, f64::max);
    maximum_end - program.anchor_resolved_seconds
}

#[allow(
    clippy::too_many_lines,
    reason = "one ordered pass keeps mixed duration and authoring projection atomic"
)]
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

    let timeline_inputs = programs
        .iter()
        .map(studio_creation_timeline_input)
        .collect::<Result<Vec<_>, _>>()?;
    let duration_program_indices = timeline_inputs
        .iter()
        .enumerate()
        .filter_map(|(index, input)| input.as_ref().map(|_| index))
        .collect::<BTreeSet<_>>();
    let duration_inputs = timeline_inputs
        .iter()
        .filter_map(Clone::clone)
        .collect::<Vec<_>>();
    if !duration_inputs.is_empty() {
        validate_studio_timeline_edits(base_duration, &duration_inputs)
            .map_err(|_| ProjectStudioCreationEditError::Unsupported)?;
    }

    // A trim's targetDuration is captured when the Program is authored, so it
    // includes every earlier Program in document history even when source-time
    // ordering later executes one of those authoring insertions after the trim.
    let mut historical_duration = base_duration;
    for (program, timeline_input) in programs.iter().zip(&timeline_inputs) {
        if let Some(timeline_input) = timeline_input {
            match &timeline_input.operations[0] {
                StudioTimelineOperation::InsertWait { interval, .. } => {
                    historical_duration += interval.end - interval.start;
                }
                StudioTimelineOperation::TrimSceneDuration {
                    removed_duration,
                    target_duration,
                    ..
                } => {
                    let expected = historical_duration - removed_duration;
                    if !expected.is_finite()
                        || *target_duration < 0.1
                        || !studio_timeline_semantic_values_match(expected, *target_duration)
                    {
                        return Err(ProjectStudioCreationEditError::Unsupported);
                    }
                    historical_duration = *target_duration;
                }
                StudioTimelineOperation::Unsupported { .. } => {
                    return Err(ProjectStudioCreationEditError::Unsupported);
                }
            }
        } else {
            historical_duration += studio_creation_insertion_duration(program);
        }
        if !historical_duration.is_finite() {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
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
    let mut net_insertions = Vec::<RankedStudioCreationInsertion>::new();
    let mut duration_program_projections = vec![None; programs.len()];
    let mut duration_transforms = Vec::with_capacity(duration_inputs.len());
    let mut timeline_state = StudioTimelinePlanningState::new(base_duration, programs.len());
    let mut authoring_offset = 0.0;
    let mut duration_trim_barrier_operation_ids = BTreeSet::new();
    let mut current_source_anchor = None;
    let mut last_wait_operation_id = None::<String>;
    for (rank, program_index) in ordered_programs.iter().copied().enumerate() {
        let program = &programs[program_index];
        if current_source_anchor.is_none_or(|anchor| {
            !studio_timeline_semantic_values_match(anchor, program.anchor_resolved_seconds)
        }) {
            current_source_anchor = Some(program.anchor_resolved_seconds);
            last_wait_operation_id = None;
        }
        ranks[program_index] = rank;
        if let Some(timeline_input) = &timeline_inputs[program_index] {
            let mut timeline_input = timeline_input.clone();
            if let StudioTimelineOperation::TrimSceneDuration {
                removed_duration,
                target_duration,
                ..
            } = &mut timeline_input.operations[0]
            {
                *target_duration = timeline_state.projected_duration() - *removed_duration;
            }
            let mut projection = timeline_state
                .project_edit(&timeline_input, program.anchor_resolved_seconds)
                .map_err(|_| ProjectStudioCreationEditError::Unsupported)?;
            projection.working_anchor -= authoring_offset;
            projection.working_interval.start -= authoring_offset;
            projection.working_interval.end -= authoring_offset;
            duration_program_projections[program_index] = Some(projection);
            let shared_transform = timeline_state
                .last_transform()
                .cloned()
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            let duration_transform = match &shared_transform {
                StudioTimelineEditTransform::Insert {
                    interval,
                    operation_id,
                } => StudioTimelineEditTransform::Insert {
                    interval: IntervalV1 {
                        end: interval.end - authoring_offset,
                        start: interval.start - authoring_offset,
                    },
                    operation_id: operation_id.clone(),
                },
                StudioTimelineEditTransform::Remove {
                    interval,
                    operation_id,
                    wait_reductions,
                } => StudioTimelineEditTransform::Remove {
                    interval: IntervalV1 {
                        end: interval.end - authoring_offset,
                        start: interval.start - authoring_offset,
                    },
                    operation_id: operation_id.clone(),
                    wait_reductions: wait_reductions.clone(),
                },
            };
            duration_transforms.push(duration_transform);
            match shared_transform {
                StudioTimelineEditTransform::Insert { interval, .. } => {
                    last_wait_operation_id = Some(program.operations[0].id.clone());
                    net_insertions.push(RankedStudioCreationInsertion {
                        projection: StudioMotionProjectionInsertion {
                            at: interval.start,
                            duration: interval.end - interval.start,
                            transaction_id: program.transaction_id.clone(),
                        },
                        rank,
                    });
                }
                StudioTimelineEditTransform::Remove { interval, .. } => {
                    remove_time_from_creation_insertions(&mut net_insertions, &interval);
                }
            }
            continue;
        }

        let insertion_duration = studio_creation_insertion_duration(program);
        let at = program.anchor_resolved_seconds + timeline_state.resolved_offset();
        if !insertion_duration.is_finite()
            || insertion_duration < 0.0
            || !at.is_finite()
            || at > base_duration + timeline_state.resolved_offset() + TIMELINE_ANCHOR_EPSILON
        {
            return Err(ProjectStudioCreationEditError::Unsupported);
        }
        if insertion_duration > 0.0 {
            if let Some(operation_id) = &last_wait_operation_id {
                duration_trim_barrier_operation_ids.insert(operation_id.clone());
            }
            let insertion = timeline_state
                .project_authoring_insertion(at, insertion_duration)
                .map_err(|_| ProjectStudioCreationEditError::Unsupported)?;
            net_insertions.push(RankedStudioCreationInsertion {
                projection: StudioMotionProjectionInsertion {
                    at: insertion.at,
                    duration: insertion.duration,
                    transaction_id: program.transaction_id.clone(),
                },
                rank,
            });
            authoring_offset += insertion_duration;
        }
    }
    for (program_index, offset) in offsets.iter_mut().enumerate() {
        let program_rank = ranks[program_index];
        *offset = net_insertions
            .iter()
            .filter(|insertion| insertion.rank < program_rank)
            .map(|insertion| insertion.projection.duration)
            .sum();
    }
    let insertions = net_insertions
        .iter()
        .map(|insertion| insertion.projection.clone())
        .collect::<Vec<_>>();
    let ranked_insertions = net_insertions
        .iter()
        .map(|insertion| {
            (
                insertion.rank,
                SceneTimelineInsertion {
                    at: insertion.projection.at,
                    duration: insertion.projection.duration,
                },
            )
        })
        .collect::<Vec<_>>();
    let mut timeline_plan = timeline_state.finish(
        duration_program_projections
            .into_iter()
            .flatten()
            .collect::<Vec<StudioTimelineEditProjection>>(),
    );
    timeline_plan.projection.transforms = duration_transforms;
    let projected_duration = timeline_plan.projection.projected_duration;
    Ok(StudioCreationTimelinePlan {
        duration_trim_barrier_operation_ids: duration_trim_barrier_operation_ids
            .into_iter()
            .collect(),
        duration_program_indices,
        insertions,
        offsets,
        ordered_programs,
        projected_duration,
        ranked_insertions,
        ranks,
        timeline_projection: timeline_plan.projection,
    })
}

fn shift_studio_creation_time(
    mut at: f64,
    program_rank: usize,
    ranked_insertions: &[(usize, SceneTimelineInsertion)],
) -> f64 {
    for (rank, insertion) in ranked_insertions {
        // A point Program ordered before an insertion at the same source
        // anchor executes immediately before that insertion. Only a point
        // strictly after the insertion moves past its inserted duration.
        if *rank > program_rank && at > insertion.at + TIMELINE_ANCHOR_EPSILON {
            at += insertion.duration;
        }
    }
    at
}

struct StudioCreationPlan {
    camera_animation: Option<PlannedStudioCameraAnimation>,
    duration_trim_barrier_operation_ids: Vec<String>,
    entities: Vec<PlannedStudioCreationEntity>,
    groups: Vec<PlannedStudioLogicalGroup>,
    motion_projection: StudioMotionProjection,
    mutations: Vec<StudioCreationProjectedMutation>,
    timeline_insertions: Vec<SceneTimelineInsertion>,
    timeline_projection: StudioTimelineProjection,
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
                    cubic_bezier: state.cubic_bezier.as_ref().map(|curve| curve.spec.clone()),
                    created_lifetime: state.lifetime.clone(),
                    data_series: state.spec.data_series.clone(),
                    entity_id: state.spec.id.clone(),
                    fill_color: matches!(
                        state.kind,
                        StudioAuthoringEntityKind::Circle
                            | StudioAuthoringEntityKind::Ellipse
                            | StudioAuthoringEntityKind::Rectangle
                            | StudioAuthoringEntityKind::RegularPolygon
                    )
                    .then(|| state.fill_color_override.clone())
                    .flatten(),
                    initial_dimensions: state.initial_dimensions,
                    initial_rotation: 0.0,
                    initial_scale: 1.0,
                    kind: state.kind,
                    image: state.spec.image.clone(),
                    layout: initial_text.as_ref().and_then(|content| {
                        (content.layout != StudioTextLayout::default()).then_some(content.layout)
                    }),
                    operation_id: state.create_operation_id.clone(),
                    stroke_color: (state.kind == StudioAuthoringEntityKind::Line).then(|| {
                        state
                            .stroke_color_override
                            .clone()
                            .unwrap_or_else(|| "#ffffff".to_owned())
                    }),
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
            duration_trim_barrier_operation_ids: self.duration_trim_barrier_operation_ids.clone(),
            entities,
            insertions: self.motion_projection.insertions.clone(),
            motions: self.motion_projection.motions.clone(),
            mutations: self.mutations.clone(),
            projected_duration: self.motion_projection.projected_duration,
            removals,
            timeline_projection: self.timeline_projection.clone(),
        }
    }
}

fn studio_creation_initial_appearance_end(state: &PlannedStudioCreationEntity) -> Option<f64> {
    state
        .fade_interval
        .as_ref()
        .or(state.draw_interval.as_ref())
        .or(state.write_interval.as_ref())
        .map(|interval| interval.end)
}

fn studio_creation_motion_is_compatible(
    state: &PlannedStudioCreationEntity,
    motion_interval: &IntervalV1,
) -> bool {
    let appearance_end = studio_creation_initial_appearance_end(state);
    let instant_is_compatible = state.instant_at.is_none_or(|at| {
        at <= motion_interval.start + TIMELINE_ANCHOR_EPSILON
            || (!state.has_position_or_resize_instant
                && rotation_is_noop(state.instant_rotation)
                && at >= motion_interval.end - TIMELINE_ANCHOR_EPSILON)
    });
    motion_interval.start >= state.lifetime.start - TIMELINE_ANCHOR_EPSILON
        && motion_interval.end <= state.lifetime.end + TIMELINE_ANCHOR_EPSILON
        && appearance_end.is_none_or(|end| motion_interval.start >= end - TIMELINE_ANCHOR_EPSILON)
        && state.animated_resize.is_none()
        && instant_is_compatible
        && state.persistent_removal.as_ref().is_none_or(|removal| {
            removal.interval.start >= motion_interval.end - TIMELINE_ANCHOR_EPSILON
                && state
                    .instant_at
                    .is_none_or(|at| removal.interval.start >= at - TIMELINE_ANCHOR_EPSILON)
                && appearance_end
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

fn studio_camera_view_is_bounded(view: &SceneCameraViewV1) -> bool {
    view.center.x.is_finite()
        && view.center.y.is_finite()
        && (-MAX_COORDINATE_V1..=MAX_COORDINATE_V1).contains(&view.center.x)
        && (-MAX_COORDINATE_V1..=MAX_COORDINATE_V1).contains(&view.center.y)
        && view.frame_width.is_finite()
        && view.frame_width > 0.0
        && view.frame_width <= MAX_COORDINATE_V1
        && view.frame_height.is_finite()
        && view.frame_height > 0.0
        && view.frame_height <= MAX_COORDINATE_V1
        && (view.frame_width / view.frame_height).is_finite()
}

fn studio_camera_views_match(left: &SceneCameraViewV1, right: &SceneCameraViewV1) -> bool {
    close_transform_baseline_value(left.center.x, right.center.x)
        && close_transform_baseline_value(left.center.y, right.center.y)
        && close_transform_baseline_value(left.frame_width, right.frame_width)
        && close_transform_baseline_value(left.frame_height, right.frame_height)
}

fn studio_camera_aspects_match(left: &SceneCameraViewV1, right: &SceneCameraViewV1) -> bool {
    close_transform_baseline_value(
        left.frame_width / left.frame_height,
        right.frame_width / right.frame_height,
    )
}

fn studio_camera_view_is_within_zoom_bounds(
    initial: &SceneCameraViewV1,
    candidate: &SceneCameraViewV1,
) -> bool {
    let width_scale = candidate.frame_width / initial.frame_width;
    let height_scale = candidate.frame_height / initial.frame_height;
    (1.0 / 16.0..=4.0).contains(&width_scale) && (1.0 / 16.0..=4.0).contains(&height_scale)
}

fn planned_studio_camera_animation(
    clips: &[PlannedStudioCameraClip],
) -> Option<PlannedStudioCameraAnimation> {
    let first = clips.first()?;
    let mut keyframes = Vec::with_capacity(clips.len() * 2 + 1);
    keyframes.push(KeyframeV1 {
        at: first.interval.start,
        easing_to_next: Some(first.easing.clone()),
        value: first.from_view.clone(),
    });
    for pair in clips.windows(2) {
        let prior = &pair[0];
        let next = &pair[1];
        if next.interval.start > prior.interval.end + TIMELINE_ANCHOR_EPSILON {
            keyframes.push(KeyframeV1 {
                at: prior.interval.end,
                easing_to_next: Some(EasingV1::Linear {}),
                value: prior.to_view.clone(),
            });
        }
        keyframes.push(KeyframeV1 {
            at: next.interval.start,
            easing_to_next: Some(next.easing.clone()),
            value: next.from_view.clone(),
        });
    }
    let final_clip = clips.last()?;
    keyframes.push(KeyframeV1 {
        at: final_clip.interval.end,
        easing_to_next: None,
        value: final_clip.to_view.clone(),
    });
    Some(PlannedStudioCameraAnimation {
        initial_view: first.from_view.clone(),
        keyframes,
    })
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

#[cfg(test)]
mod tests;
