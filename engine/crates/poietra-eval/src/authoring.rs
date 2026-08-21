use std::collections::{BTreeMap, BTreeSet};

use poietra_scene_ir::{
    CubicPathV1, FillRuleV1, FillStyleV1, PointV1, RgbaColorV1, SceneAppearanceV1, SceneIrBundleV1,
    StrokeCapV1, StrokeJoinV1, StrokeStyleV1,
};
use serde::{Deserialize, Serialize};

mod bound_entity;
mod creation;
mod cubic_bezier;
mod fragment_material;
mod identity;
mod math_tex_transform;
mod motion;
mod presence;
mod static_root;
mod svg_path;
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
    StudioCreationImageSpec, StudioCreationOperation, StudioCreationOperationKind,
    StudioCreationProjectedMutation, StudioCreationProjectedMutationKind, StudioCreationProjection,
    StudioCreationSvgPathSpec, StudioProjectedCreationEntity, StudioPropertyEasing,
    project_studio_creation_edits,
};
pub use cubic_bezier::{
    StudioCreationCubicBezierSpec, StudioCubicBezierError, StudioCubicBezierInspection,
    StudioCubicBezierStrokeCap, inspect_studio_cubic_bezier,
};
pub use fragment_material::{
    ApplyStudioFragmentMaterialsCommand, ApplyStudioFragmentMaterialsError,
    StudioFragmentMaterialAssignment,
};
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
    StudioMotionProjectionTarget, one_projection_lifetime, plan_studio_motion_edits,
    project_standalone_motion_edits, project_studio_motion_plan,
};
pub use presence::{
    ApplyStudioPersistentRemoveError, StudioPersistentRemoveProjection,
    StudioPersistentRemoveProjectionEntry,
};
use static_root::static_root_transform_edit_input_is_closed;
pub use static_root::{
    ApplyStaticRootTransformEditCommand, ApplyStaticRootTransformEditError,
    StaticRootTransformEditInput, StaticRootTransformOperation, StaticRootTransformOperationKind,
    StudioStaticRootProjection,
};
#[allow(
    unused_imports,
    reason = "preserve the existing authoring API while its projection leaves are test-only here"
)]
pub use static_root::{StudioStaticRootMutation, StudioStaticRootProjectedMutation};
pub use svg_path::{
    MAX_STUDIO_SVG_SOURCE_BYTES, StudioSvgPathAssetInspection, StudioSvgPathError,
    inspect_studio_svg_path_asset,
};
pub use timeline::{
    ApplyStudioTimelineEditCommand, ApplyStudioTimelineEditError, StudioTimelineEditInput,
    StudioTimelineEditProjection, StudioTimelineEditTransform, StudioTimelineEventKind,
    StudioTimelineOperation, StudioTimelineProjection, StudioTimelinePurpose,
    StudioTimelineWaitReduction, project_studio_timeline_edits,
};
#[allow(
    unused_imports,
    reason = "preserve the existing authoring API while the primitive methods remain crate-private"
)]
pub use transform::{
    RotateSceneEntityCommand, RotateSceneEntityError, ScaleAboutPivot, SceneEntityAxisFactors,
    SetSubtreeVectorPaintAlphaCommand, SetSubtreeVectorPaintAlphaError,
    TransformSceneEntityAtTimeCommand, TransformSceneEntityCommand, TransformSceneEntityError,
    TransformSceneEntityExpectedBaseline, TransformSceneEntityIntent,
};

const TIMELINE_ANCHOR_EPSILON: f64 = 0.0005;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StudioProjectionEasing {
    Linear,
    ManimSmooth,
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
    Arc,
    Arrow,
    Axes,
    Circle,
    CubicBezier,
    DataPlot,
    Ellipse,
    Image,
    Line,
    MathTex,
    NumberLine,
    NumberPlane,
    Other,
    Rectangle,
    RegularPolygon,
    Sector,
    SvgPath,
    Text,
}

pub type StaticRootTransformEntityKind = StudioAuthoringEntityKind;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioAuthoringSize {
    pub height: f64,
    pub width: f64,
}

pub type StaticRootTransformSize = StudioAuthoringSize;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioAuthoringAngles {
    pub start: f64,
    pub sweep: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioAuthoringCoordinateRange {
    pub maximum: f64,
    pub minimum: f64,
    pub step: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioAuthoringCoordinateSystem {
    pub x: StudioAuthoringCoordinateRange,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<StudioAuthoringCoordinateRange>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioAuthoringDimensions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub angles: Option<StudioAuthoringAngles>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinate_system: Option<StudioAuthoringCoordinateSystem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radius: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sides: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
}

pub type StaticRootTransformDimensions = StudioAuthoringDimensions;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationMathTexOutline {
    pub entity_id: String,
    pub path: CubicPathV1,
    pub tex_parts: Vec<String>,
}

/// One ordered path fragment produced by the browser's segmented `MathTex` compiler.
///
/// The compiler-owned fragment id is correlation metadata only. The canonical
/// Scene entity ids are derived from the Studio root id inside the authoring core.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationSegmentedMathTexFragment {
    pub fill_entity_id: String,
    pub fill_rule: FillRuleV1,
    pub id: String,
    pub order: u32,
    pub outline_entity_id: String,
    pub paint: RgbaColorV1,
    pub path: CubicPathV1,
    pub source_correlation: StudioCreationSegmentedMathTexSourceCorrelation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum StudioCreationSegmentedMathTexSourceCorrelationKind {
    ExpressionByteRange,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationSegmentedMathTexSourceCorrelation {
    pub kind: StudioCreationSegmentedMathTexSourceCorrelationKind,
    pub source_end_byte: u32,
    pub source_start_byte: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum StudioCreationSegmentedMathTexRepresentation {
    SeparateOutlineAndFillEntities,
}

/// Timing and stroke parameters for a two-phase Studio `MathTex` Write.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationSegmentedMathTexWritePlan {
    pub fragment_lag_ratio: f64,
    pub outline_stroke_width: f64,
    pub phase_boundary: f64,
    pub representation: StudioCreationSegmentedMathTexRepresentation,
}

/// Segmented `MathTex` boundary artifact admitted by the canonical creation core.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationSegmentedMathTexOutline {
    pub entity_id: String,
    pub fragments: Vec<StudioCreationSegmentedMathTexFragment>,
    pub source: String,
    pub write_plan: StudioCreationSegmentedMathTexWritePlan,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StudioTextAlignment {
    Center,
    #[default]
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StudioTextFontWeight {
    Bold,
    #[default]
    Regular,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StudioTextFontFamily {
    Mono,
    #[default]
    Sans,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioTextLayout {
    pub alignment: StudioTextAlignment,
    #[serde(default)]
    pub font_family: StudioTextFontFamily,
    #[serde(default = "default_studio_text_font_size")]
    pub font_size: f64,
    #[serde(default)]
    pub font_weight: StudioTextFontWeight,
    pub line_height: f64,
}

const fn default_studio_text_font_size() -> f64 {
    1.0
}

impl Default for StudioTextLayout {
    fn default() -> Self {
        Self {
            alignment: StudioTextAlignment::Left,
            font_family: StudioTextFontFamily::Sans,
            font_size: default_studio_text_font_size(),
            font_weight: StudioTextFontWeight::Regular,
            line_height: 1.2,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioTextContent {
    pub layout: StudioTextLayout,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationTextOutline {
    pub entity_id: String,
    #[serde(default)]
    pub layout: StudioTextLayout,
    pub path: CubicPathV1,
    pub text: String,
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
    match (
        kind,
        dimensions.angles,
        dimensions.coordinate_system,
        dimensions.radius,
        dimensions.sides,
        dimensions.width,
        dimensions.height,
    ) {
        (StaticRootTransformEntityKind::Circle, None, None, Some(radius), None, None, None)
            if radius.is_finite() && radius > 0.0 =>
        {
            Some(StudioAuthoringSize {
                height: radius * 2.0,
                width: radius * 2.0,
            })
        }
        (
            StaticRootTransformEntityKind::Rectangle,
            None,
            None,
            None,
            None,
            Some(width),
            Some(height),
        ) if width.is_finite() && width > 0.0 && height.is_finite() && height > 0.0 => {
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
                | StaticRootTransformOperationKind::Rotation { .. }
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

fn studio_arrow_appearance() -> SceneAppearanceV1 {
    SceneAppearanceV1::Vector {
        fill: Some(FillStyleV1 {
            color: studio_white(),
            fragment_material: None,
            rule: FillRuleV1::NonZero,
        }),
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
            fragment_material: None,
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

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    pub(super) use super::math_tex_transform::tests::{
        math_tex_fixture_path, static_imported_math_tex_bundle,
    };
    use poietra_scene_ir::{
        AnimationChannelV1, EasingV1, IntervalV1, RuntimeTraceVersionV1, SceneCapabilityV1,
        SceneIrBundleV1, SceneSourceV1, SnapshotProfileVersionV1, parse_scene_ir_bundle_json_v1,
    };

    use crate::EngineSessionV1;

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

    pub(super) fn static_root_position_command() -> ApplyStaticRootTransformEditCommand {
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
                    angles: None,
                    coordinate_system: None,
                    height: None,
                    radius: Some(0.5),
                    sides: None,
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
    fn applies_move_or_resize_then_motion_without_a_visual_center_jump() {
        let moved = static_root_position_command();
        let mut resized = static_root_position_command();
        resized.programs[0].operations[0].kind = StaticRootTransformOperationKind::Resize {
            from_dimensions: StaticRootTransformDimensions {
                angles: None,
                coordinate_system: None,
                height: None,
                radius: Some(0.5),
                sides: None,
                width: None,
            },
            from_position: PointV1 { x: 360.0, y: 180.0 },
            from_scale: 1.0,
            shape: StaticRootTransformEntityKind::Circle,
            to_dimensions: StaticRootTransformDimensions {
                angles: None,
                coordinate_system: None,
                height: None,
                radius: Some(1.0),
                sides: None,
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
