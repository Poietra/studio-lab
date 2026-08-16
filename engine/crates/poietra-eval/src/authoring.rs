use std::collections::{BTreeMap, BTreeSet};

use poietra_geometry::manim_cubic_chord_length_v1;
use poietra_scene_ir::{
    AffineTransformV1, AnimationChannelV1, ContractVersionV1, CubicPathV1, CubicSegmentV1,
    CubicSubpathV1, EasingV1, FidelityV1, FillRuleV1, FillStyleV1, IntervalV1, KeyframeV1,
    MotionPathParameterizationV1, PointV1, ProvenanceOriginV1, ProvenanceRecordV1, RgbaColorV1,
    SceneAppearanceV1, SceneCapabilityV1, SceneEntityV1, SceneGeometryV1, SceneIrBundleV1,
    SceneSourceV1, StrokeCapV1, StrokeJoinV1, StrokeStyleV1,
};
use serde::{Deserialize, Serialize};

use crate::{EngineSessionV1, EvaluationError};

const ROTATION_NOOP_EPSILON: f64 = 1e-12;
const TIMELINE_ANCHOR_EPSILON: f64 = 0.0005;

#[derive(Clone, Debug, PartialEq)]
enum CreateSceneEntityGeometry {
    Circle { radius: f64 },
    Line,
    Rectangle { height: f64, width: f64 },
    MathTex { path: CubicPathV1 },
}

#[derive(Clone, Debug, PartialEq)]
struct CreateSceneEntityFadeIn {
    end: f64,
}

#[derive(Clone, Debug, PartialEq)]
struct CreateSceneEntityInstantTransform {
    at: f64,
    position: PointV1,
    scale_x: f64,
    scale_y: f64,
}

#[derive(Clone, Debug, PartialEq)]
struct CreateSceneEntity {
    fade_in: Option<CreateSceneEntityFadeIn>,
    geometry: CreateSceneEntityGeometry,
    id: String,
    lifetime: IntervalV1,
    position: PointV1,
    scale: f64,
    instant_transform: Option<CreateSceneEntityInstantTransform>,
}

/// One insertion into an existing Scene timeline.
#[derive(Clone, Debug, PartialEq)]
struct SceneTimelineInsertion {
    at: f64,
    duration: f64,
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

#[derive(Clone, Debug, PartialEq)]
struct CreateSceneEntitiesCommand {
    entities: Vec<CreateSceneEntity>,
    expected_base_revision: String,
    motions: Vec<PlannedSceneMotion>,
    next_revision: String,
    persistent_removals: Vec<PersistentSceneRemoval>,
    provenance: ProvenanceRecordV1,
    timeline_insertions: Vec<SceneTimelineInsertion>,
}

#[derive(Clone, Debug, PartialEq)]
struct PersistentSceneRemoval {
    entity_id: String,
    interval: IntervalV1,
    operation_id: String,
    studio_entity_id: String,
    transaction_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioPersistentRemoveProjectionEntry {
    pub affected_scene_entity_ids: Vec<String>,
    pub fade_interval: Option<IntervalV1>,
    pub operation_id: String,
    pub removed_at: f64,
    pub resulting_lifetime_end: f64,
    pub scene_entity_id: String,
    pub studio_entity_id: String,
    pub transaction_id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioPersistentRemoveProjection {
    pub removals: Vec<StudioPersistentRemoveProjectionEntry>,
}

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
    pub mutations: Vec<StudioStaticRootProjectedMutation>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioMotionProjectionInsertion {
    pub at: f64,
    pub duration: f64,
    pub transaction_id: String,
}

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
pub struct StudioProjectedMotion {
    pub control: PointV1,
    pub control_offset: PointV1,
    pub delta: PointV1,
    pub easing: StudioMotionEasing,
    pub from: PointV1,
    pub interval: IntervalV1,
    pub operation_id: String,
    pub source_interval: IntervalV1,
    pub target_entity_id: String,
    pub to: PointV1,
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

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StudioMotionEasing {
    Linear,
    Smooth,
}

/// One normalized motion segment projected in Studio coordinates.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioMotionProjection {
    pub insertions: Vec<StudioMotionProjectionInsertion>,
    pub motions: Vec<StudioProjectedMotion>,
    pub projected_duration: f64,
}

/// One Studio-owned entity created by an admitted creation Program.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioProjectedCreationEntity {
    pub created_lifetime: IntervalV1,
    pub entity_id: String,
    pub initial_dimensions: StudioAuthoringDimensions,
    pub initial_scale: f64,
    pub kind: StudioAuthoringEntityKind,
    pub operation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tex_parts: Option<Vec<String>>,
    pub transaction_id: String,
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

#[derive(Clone, Debug, PartialEq)]
struct CreateSceneMotionCommand {
    control_offset: PointV1,
    delta: PointV1,
    easing: StudioMotionEasing,
    expected_base_revision: String,
    interval: IntervalV1,
    next_revision: String,
    provenance: ProvenanceRecordV1,
    target_entity_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct PlannedSceneMotion {
    control_offset: PointV1,
    delta: PointV1,
    easing: StudioMotionEasing,
    interval: IntervalV1,
    target_entity_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct PlannedStudioMotion {
    base_interval: IntervalV1,
    control_offset: PointV1,
    delta: PointV1,
    easing: StudioMotionEasing,
    interval: IntervalV1,
    operation_id: String,
    parallel: bool,
    target_entity_ids: Vec<String>,
    transaction_id: String,
}

#[derive(Clone, Debug, PartialEq)]
struct StudioMotionPlan {
    insertions: Vec<StudioMotionProjectionInsertion>,
    motions: Vec<PlannedStudioMotion>,
    projected_duration: f64,
    timeline_insertions: Vec<SceneTimelineInsertion>,
}

#[derive(Clone, Debug, PartialEq)]
struct PlannedEntityMotionSegment {
    easing: StudioMotionEasing,
    interval: IntervalV1,
    segment: CubicSegmentV1,
}

#[derive(Clone, Debug, PartialEq)]
struct PlannedEntityMotionPath {
    current: PointV1,
    segments: Vec<PlannedEntityMotionSegment>,
    start: PointV1,
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

/// One profile-free Studio command that rotates a root entity in world space.
#[derive(Clone, Debug, PartialEq)]
pub struct RotateSceneEntityCommand {
    pub angle_radians: f64,
    pub entity_id: String,
    pub expected_base_revision: String,
    pub next_revision: String,
    pub pivot: PointV1,
    pub provenance: ProvenanceRecordV1,
}

/// One optional positive axis scale within an atomic world-space transform.
#[derive(Clone, Debug, PartialEq)]
pub struct ScaleAboutPivot {
    pub pivot: PointV1,
    pub x_factor: f64,
    pub y_factor: f64,
}

/// Positive axis factors requested by a Studio transform.
#[derive(Clone, Debug, PartialEq)]
pub struct SceneEntityAxisFactors {
    pub x_factor: f64,
    pub y_factor: f64,
}

/// Studio semantic baseline that must still match the installed Scene geometry.
#[derive(Clone, Debug, PartialEq)]
pub enum TransformSceneEntityExpectedBaseline {
    CurrentCenter,
    CurrentUniformAffine,
    WorldSize {
        height: f64,
        width: f64,
        world_center: PointV1,
    },
}

/// One profile-free transform intent resolved by the canonical Scene core.
#[derive(Clone, Debug, PartialEq)]
pub enum TransformSceneEntityIntent {
    Relative {
        delta: PointV1,
        scale: Option<ScaleAboutPivot>,
    },
    FromBaseline {
        expected_baseline: TransformSceneEntityExpectedBaseline,
        scale: Option<SceneEntityAxisFactors>,
        target_center: Option<PointV1>,
    },
}

/// One profile-free Studio command that atomically transforms an authorized entity.
#[derive(Clone, Debug, PartialEq)]
pub struct TransformSceneEntityCommand {
    pub entity_id: String,
    pub expected_base_revision: String,
    pub intent: TransformSceneEntityIntent,
    pub next_revision: String,
    pub provenance: ProvenanceRecordV1,
}

/// One profile-free Studio transform that becomes active at an exact Scene time.
#[derive(Clone, Debug, PartialEq)]
pub struct TransformSceneEntityAtTimeCommand {
    pub at: f64,
    pub delta: PointV1,
    pub entity_id: String,
    pub expected_base_revision: String,
    pub next_revision: String,
    pub provenance: ProvenanceRecordV1,
    pub scale: Option<ScaleAboutPivot>,
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
pub enum StudioProgramExecution {
    Parallel,
    Sequence,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum StudioProgramScheduleMode {
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
pub enum StudioProgramAnchorSource {
    Absolute { seconds: Option<f64> },
    Playhead { reference_seconds: Option<f64> },
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StudioMotionOperation {
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
    Unsupported {
        depends_on: Vec<String>,
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
    },
}

impl StudioMotionOperation {
    fn depends_on(&self) -> &[String] {
        match self {
            Self::CreateMotion { depends_on, .. } | Self::Unsupported { depends_on, .. } => {
                depends_on
            }
        }
    }

    fn id(&self) -> &str {
        match self {
            Self::CreateMotion { id, .. } | Self::Unsupported { id, .. } => id,
        }
    }

    fn interval(&self) -> &IntervalV1 {
        match self {
            Self::CreateMotion { interval, .. } | Self::Unsupported { interval, .. } => interval,
        }
    }

    fn origin(&self) -> StudioAuthoringOrigin {
        match self {
            Self::CreateMotion { origin, .. } | Self::Unsupported { origin, .. } => *origin,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioMotionProgram {
    pub anchor_captured_playhead: f64,
    pub anchor_resolved_seconds: f64,
    pub anchor_source: StudioProgramAnchorSource,
    pub intent_count: usize,
    pub lowering_supported: bool,
    pub operations: Vec<StudioMotionOperation>,
    pub origin: StudioAuthoringOrigin,
    pub requested_execution: StudioProgramExecution,
    pub schedule_edge_count: usize,
    pub schedule_mode: StudioProgramScheduleMode,
    pub schedule_order: Vec<String>,
    pub transaction_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioMotionEntityIdentity {
    pub object_graph_key: String,
    pub provisional: bool,
    pub source_identity: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioMotionProjectionEntityIdentity {
    #[serde(flatten)]
    pub identity: StudioMotionEntityIdentity,
    pub lifetime: Vec<IntervalV1>,
    pub position: PointV1,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioMotionSourceBinding {
    pub runtime_entity_id: String,
    pub source_identity_key: String,
    pub source_name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStudioMotionEditCommand {
    pub expected_base_revision: String,
    pub frame: StudioAuthoringSize,
    pub next_revision: String,
    pub programs: Vec<StudioMotionProgram>,
    pub source_runtime_bindings: Vec<StudioMotionSourceBinding>,
    pub studio_entities: Vec<StudioMotionEntityIdentity>,
    pub viewport: StudioAuthoringSize,
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
        programs: Vec<StudioMotionProgram>,
        studio_entities: Vec<StudioMotionProjectionEntityIdentity>,
    },
    StaticRoot {
        programs: Vec<StaticRootTransformProgram>,
        studio_entities: Vec<StaticRootMotionProjectionEntityIdentity>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectStudioMotionEditCommand {
    pub base_duration: f64,
    pub batch: StudioMotionProjectionBatch,
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
pub struct StudioMathTexTransformProgram {
    pub anchor_captured_playhead: f64,
    pub anchor_resolved_seconds: f64,
    pub anchor_source: StudioProgramAnchorSource,
    pub intent_count: usize,
    pub lowering_supported: bool,
    pub operations: Vec<StudioMathTexTransformOperation>,
    pub origin: StudioAuthoringOrigin,
    pub requested_execution: StudioProgramExecution,
    pub schedule_edge_count: usize,
    pub schedule_mode: StudioProgramScheduleMode,
    pub schedule_order: Vec<String>,
    pub transaction_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioMathTexTransformEntityIdentity {
    pub object_graph_key: String,
    pub position: Option<PointV1>,
    pub provisional: bool,
    pub scale: Option<f64>,
    pub source_identity: Option<String>,
    #[serde(rename = "type")]
    pub entity_type: StudioAuthoringEntityKind,
}

/// Logical Studio entity facts used to authorize a `MathTex` transform without a Scene snapshot.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioMathTexTransformProjectionEntityIdentity {
    pub lifetime: Vec<IntervalV1>,
    pub object_graph_key: String,
    pub position: Option<PointV1>,
    pub provisional: bool,
    pub scale: Option<f64>,
    pub source_identity: Option<String>,
    #[serde(rename = "type")]
    pub entity_type: StudioAuthoringEntityKind,
}

pub type StudioMathTexTransformSourceBinding = StudioMotionSourceBinding;
pub type StudioMathTexTransformOutline = StudioCreationMathTexOutline;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStudioMathTexTransformEditCommand {
    pub expected_base_revision: String,
    pub frame: StudioAuthoringSize,
    pub math_tex_outlines: Vec<StudioMathTexTransformOutline>,
    pub next_revision: String,
    pub programs: Vec<StudioMathTexTransformProgram>,
    pub source_runtime_bindings: Vec<StudioMathTexTransformSourceBinding>,
    pub studio_entities: Vec<StudioMathTexTransformEntityIdentity>,
    pub viewport: StudioAuthoringSize,
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

pub type StudioBoundEntityExecution = StudioProgramExecution;
pub type StudioBoundEntityScheduleMode = StudioProgramScheduleMode;
pub type StudioBoundEntityAnchorSource = StudioProgramAnchorSource;

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
pub struct StudioBoundEntityProgram {
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
    pub programs: Vec<StudioBoundEntityProgram>,
    pub viewport: StudioAuthoringSize,
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
pub struct StaticRootTransformProgram {
    pub anchor_captured_playhead: f64,
    pub anchor_resolved_seconds: f64,
    pub anchor_source: StudioProgramAnchorSource,
    pub intent_count: usize,
    pub lowering_supported: bool,
    pub operations: Vec<StaticRootTransformOperation>,
    pub origin: StaticRootTransformOrigin,
    pub requested_execution: StudioProgramExecution,
    pub schedule_edge_count: usize,
    pub schedule_mode: StudioProgramScheduleMode,
    pub schedule_order: Vec<String>,
    pub transaction_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StaticRootTransformStudioEntity {
    pub dimensions: StaticRootTransformDimensions,
    pub object_graph_key: String,
    pub id: String,
    pub kind: StaticRootTransformEntityKind,
    pub position: Option<PointV1>,
    pub provisional: bool,
    pub scale: Option<f64>,
    pub source_identity: Option<String>,
    pub transaction_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StaticRootMotionProjectionEntityIdentity {
    #[serde(flatten)]
    pub identity: StaticRootTransformStudioEntity,
    pub lifetime: Vec<IntervalV1>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StaticRootTransformSourceBinding {
    pub source_identity_key: String,
    pub runtime_entity_id: String,
    pub source_name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStaticRootTransformEditCommand {
    pub expected_base_revision: String,
    pub frame: StaticRootTransformSize,
    pub math_tex_outlines: Vec<StudioCreationMathTexOutline>,
    pub next_revision: String,
    pub programs: Vec<StaticRootTransformProgram>,
    pub source_runtime_bindings: Vec<StaticRootTransformSourceBinding>,
    pub studio_entities: Vec<StaticRootTransformStudioEntity>,
    pub viewport: StaticRootTransformSize,
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
pub struct StudioTimelineProgram {
    pub anchor_captured_playhead: f64,
    pub anchor_resolved_seconds: f64,
    pub anchor_source: StudioProgramAnchorSource,
    pub intent_count: usize,
    pub lowering_supported: bool,
    pub operations: Vec<StudioTimelineOperation>,
    pub origin: StudioAuthoringOrigin,
    pub requested_execution: StudioProgramExecution,
    pub schedule_edge_count: usize,
    pub schedule_mode: StudioProgramScheduleMode,
    pub schedule_order: Vec<String>,
    pub transaction_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStudioTimelineEditCommand {
    pub expected_base_revision: String,
    pub next_revision: String,
    pub programs: Vec<StudioTimelineProgram>,
}

/// One input Program projected into the working timeline.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioTimelineProgramProjection {
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

/// One ordered time-axis transform produced by a normalized timeline Program.
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

/// Pure projection of normalized timeline Programs from source time into working time.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioTimelineProjection {
    pub program_projections: Vec<StudioTimelineProgramProjection>,
    pub projected_duration: f64,
    pub transforms: Vec<StudioTimelineEditTransform>,
}

#[derive(Clone, Debug, PartialEq)]
struct StudioTimelinePlan {
    edits: Vec<SceneTimelineEdit>,
    operation_ids: Vec<String>,
    projection: StudioTimelineProjection,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationEntitySpec {
    pub dimensions: StudioAuthoringDimensions,
    pub id: String,
    pub kind: StudioAuthoringEntityKind,
    pub lifetime_end: Option<f64>,
    pub lifetime_start: f64,
    pub tex_parts: Option<Vec<String>>,
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
pub struct StudioCreationProgram {
    pub anchor_captured_playhead: f64,
    pub anchor_resolved_seconds: f64,
    pub anchor_source: StudioProgramAnchorSource,
    pub intent_count: usize,
    pub lowering_supported: bool,
    pub operations: Vec<StudioCreationOperation>,
    pub origin: StudioAuthoringOrigin,
    pub requested_execution: StudioProgramExecution,
    pub schedule_edge_count: usize,
    pub schedule_mode: StudioProgramScheduleMode,
    pub schedule_order: Vec<String>,
    pub transaction_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationMathTexOutline {
    pub entity_id: String,
    pub path: CubicPathV1,
    pub tex_parts: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStudioCreationEditCommand {
    pub expected_base_revision: String,
    pub frame: StudioAuthoringSize,
    pub math_tex_outlines: Vec<StudioCreationMathTexOutline>,
    pub next_revision: String,
    pub programs: Vec<StudioCreationProgram>,
    pub viewport: StudioAuthoringSize,
}

/// One profile-free Studio command that sets vector-paint alpha in one root subtree.
#[derive(Clone, Debug, PartialEq)]
pub struct SetSubtreeVectorPaintAlphaCommand {
    pub alpha: f64,
    pub expected_base_revision: String,
    pub next_revision: String,
    pub provenance: ProvenanceRecordV1,
    pub root_entity_id: String,
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
    #[error(transparent)]
    Motion(#[from] ApplyStudioMotionEditError),
    #[error(transparent)]
    PersistentRemove(#[from] ApplyStudioPersistentRemoveError),
    #[error("the Scene containing the created entities failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyStudioPersistentRemoveError {
    #[error("a persistent remove command must contain at least one target")]
    EmptyBatch,
    #[error("a persistent remove interval must be finite and inside the Scene")]
    InvalidInterval,
    #[error("a persistent remove command contains a duplicate target: {0}")]
    DuplicateTarget(String),
    #[error("persistent remove targets overlap in one Scene subtree: {0} and {1}")]
    OverlappingTargets(String, String),
    #[error("the persistent remove target does not exist: {0}")]
    TargetMissing(String),
    #[error("persistent remove currently requires a root entity: {0}")]
    TargetIsNotRoot(String),
    #[error("the persistent remove target is not active for the complete interval: {0}")]
    TargetInactive(String),
    #[error("the persistent remove target already has overlapping opacity animation: {0}")]
    OpacityAnimationConflict(String),
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyStudioMotionEditError {
    #[error("the normalized Studio Programs do not authorize one imported Scene motion")]
    Unsupported,
    #[error("the installed Scene revision does not match expectedBaseRevision")]
    StaleBaseRevision,
    #[error("the motion command must advance to a different Scene revision")]
    RevisionDidNotAdvance,
    #[error("the motion interval must be finite, non-negative, non-empty, and inside the Scene")]
    InvalidInterval,
    #[error("motion points must be finite and the delta or control offset must be non-zero")]
    InvalidMotion,
    #[error("a motion command must contain at least one target")]
    EmptyTargets,
    #[error("the motion command contains a duplicate target: {0}")]
    DuplicateTarget(String),
    #[error("the motion target does not exist: {0}")]
    TargetMissing(String),
    #[error("world-space motion currently requires a root entity: {0}")]
    TargetIsNotRoot(String),
    #[error("the motion target is not active for the complete interval: {0}")]
    TargetInactive(String),
    #[error("world-space motion does not support an already animated transform target: {0}")]
    AnimatedTransformUnsupported(String),
    #[error("the motion provenance ID already exists: {0}")]
    ProvenanceConflict(String),
    #[error("the authored motion Scene failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
}

#[derive(Debug, thiserror::Error)]
pub enum ProjectStudioMotionEditError {
    #[error("the normalized Studio Programs do not authorize one motion-bearing batch")]
    Unsupported,
}

#[derive(Debug, thiserror::Error)]
pub enum ProjectStudioCreationEditError {
    #[error("the normalized Studio Programs do not authorize one creation batch")]
    Unsupported,
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

#[derive(Debug, thiserror::Error)]
pub enum ApplyStudioTimelineEditError {
    #[error(
        "the normalized Studio Programs do not authorize one static imported Scene timeline edit"
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

#[derive(Debug, thiserror::Error)]
pub enum RotateSceneEntityError {
    #[error("the installed Scene revision does not match expectedBaseRevision")]
    StaleBaseRevision,
    #[error("the rotation must advance to a different Scene revision")]
    RevisionDidNotAdvance,
    #[error("the rotation angle must be finite and non-zero")]
    InvalidAngle,
    #[error("the world-space rotation pivot must be finite")]
    InvalidPivot,
    #[error("the rotation target does not exist: {0}")]
    TargetMissing(String),
    #[error("world-space rotation currently requires a root entity: {0}")]
    TargetIsNotRoot(String),
    #[error("world-space rotation does not yet support an animated transform target: {0}")]
    AnimatedTransformUnsupported(String),
    #[error("the rotation provenance must use the Studio Edit Program origin")]
    InvalidProvenanceOrigin,
    #[error("the rotation provenance ID already exists: {0}")]
    ProvenanceConflict(String),
    #[error("the rotated Scene failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
}

#[derive(Debug, thiserror::Error)]
pub enum TransformSceneEntityError {
    #[error("the installed Scene revision does not match expectedBaseRevision")]
    StaleBaseRevision,
    #[error("the transform must advance to a different Scene revision")]
    RevisionDidNotAdvance,
    #[error("the world-space translation delta must be finite")]
    InvalidDelta,
    #[error(
        "axis scale factors must be finite and positive; relative factors must not both be identity"
    )]
    InvalidFactor,
    #[error("the optional world-space scale pivot must be finite")]
    InvalidPivot,
    #[error("the transform must contain a non-zero translation or an axis scale")]
    NoOp,
    #[error("the timed transform anchor must be finite, non-negative, and before Scene end")]
    InvalidAnchor,
    #[error("the timed transform scale must be uniform")]
    NonUniformFactor,
    #[error("the transform target does not exist: {0}")]
    TargetMissing(String),
    #[error("this world-space transform requires a root entity: {0}")]
    TargetIsNotRoot(String),
    #[error("the timed transform target is not active at its anchor: {0}")]
    TargetInactive(String),
    #[error("world-space transform does not yet support an animated transform target: {0}")]
    AnimatedTransformUnsupported(String),
    #[error("world-space transform requires identity, transform-static ancestors: {0}")]
    TransformedAncestorUnsupported(String),
    #[error("the transform target geometry has no supported local bounds")]
    BaselineUnavailable,
    #[error("the expected transform baseline is invalid or does not match the installed Scene")]
    BaselineMismatch,
    #[error("the target center must be finite")]
    InvalidTargetCenter,
    #[error("the transform provenance must use the Studio Edit Program origin")]
    InvalidProvenanceOrigin,
    #[error("the transform provenance ID already exists: {0}")]
    ProvenanceConflict(String),
    #[error("the transformed Scene failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
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

#[derive(Debug, thiserror::Error)]
pub enum ApplyStudioCreationEditError {
    #[error("the normalized Studio edit does not authorize one entity-creation batch")]
    Unsupported,
    #[error(transparent)]
    Create(#[from] CreateSceneEntitiesError),
}

#[derive(Debug, thiserror::Error)]
pub enum SetSubtreeVectorPaintAlphaError {
    #[error("the installed Scene revision does not match expectedBaseRevision")]
    StaleBaseRevision,
    #[error("the vector-paint alpha edit must advance to a different Scene revision")]
    RevisionDidNotAdvance,
    #[error("the vector-paint alpha must be finite and between zero and one")]
    InvalidAlpha,
    #[error("the vector-paint alpha root does not exist: {0}")]
    TargetMissing(String),
    #[error("the vector-paint alpha target must be a root entity: {0}")]
    TargetIsNotRoot(String),
    #[error("the vector-paint alpha subtree contains an unsupported entity: {0}")]
    UnsupportedSubtreeEntity(String),
    #[error("the vector-paint alpha subtree contains animated paint: {0}")]
    AnimatedPaintUnsupported(String),
    #[error("the vector-paint alpha provenance must use the Studio Edit Program origin")]
    InvalidProvenanceOrigin,
    #[error("the vector-paint alpha provenance ID already exists: {0}")]
    ProvenanceConflict(String),
    #[error("the vector-paint alpha edit did not change any paint")]
    NoPaintChanged,
    #[error("the vector-paint alpha Scene failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
}

fn rotation_is_noop(angle_radians: f64) -> bool {
    let normalized = angle_radians.sin().atan2(angle_radians.cos());
    normalized.abs() <= ROTATION_NOOP_EPSILON
}

fn apply_world_translation(transform: &mut poietra_scene_ir::AffineTransformV1, delta: &PointV1) {
    transform.tx += delta.x;
    transform.ty += delta.y;
}

fn apply_world_axis_scale(
    transform: &mut poietra_scene_ir::AffineTransformV1,
    x_factor: f64,
    y_factor: f64,
    pivot: &PointV1,
) {
    *transform = poietra_scene_ir::AffineTransformV1 {
        m11: x_factor * transform.m11,
        m12: x_factor * transform.m12,
        m21: y_factor * transform.m21,
        m22: y_factor * transform.m22,
        tx: pivot.x + x_factor * (transform.tx - pivot.x),
        ty: pivot.y + y_factor * (transform.ty - pivot.y),
    };
}

fn has_animated_transform(scene: &poietra_scene_ir::SceneIrV1, entity_id: &str) -> bool {
    scene.animation_channels.iter().any(|channel| {
        matches!(
            channel,
            AnimationChannelV1::AffineTransform { entity_id: animated_id, .. }
                | AnimationChannelV1::MotionPath { entity_id: animated_id, .. }
                if animated_id == entity_id
        )
    })
}

#[derive(Clone, Copy)]
struct SceneEntityLocalBounds {
    bottom: f64,
    left: f64,
    right: f64,
    top: f64,
}

fn cubic_path_local_bounds(path: &CubicPathV1) -> Option<SceneEntityLocalBounds> {
    let first = path.subpaths.first()?;
    let mut bounds = SceneEntityLocalBounds {
        bottom: first.start.y,
        left: first.start.x,
        right: first.start.x,
        top: first.start.y,
    };
    for subpath in &path.subpaths {
        for point in std::iter::once(&subpath.start).chain(
            subpath
                .segments
                .iter()
                .flat_map(|segment| [&segment.control1, &segment.control2, &segment.end]),
        ) {
            bounds.bottom = bounds.bottom.min(point.y);
            bounds.left = bounds.left.min(point.x);
            bounds.right = bounds.right.max(point.x);
            bounds.top = bounds.top.max(point.y);
        }
    }
    Some(bounds)
}

fn scene_entity_local_bounds(entity: &SceneEntityV1) -> Option<SceneEntityLocalBounds> {
    match &entity.geometry {
        SceneGeometryV1::Circle { center, radius } => Some(SceneEntityLocalBounds {
            bottom: center.y - radius,
            left: center.x - radius,
            right: center.x + radius,
            top: center.y + radius,
        }),
        SceneGeometryV1::Rectangle {
            center,
            height,
            width,
            ..
        } => Some(SceneEntityLocalBounds {
            bottom: center.y - height / 2.0,
            left: center.x - width / 2.0,
            right: center.x + width / 2.0,
            top: center.y + height / 2.0,
        }),
        SceneGeometryV1::Image { local_rect, .. } => Some(SceneEntityLocalBounds {
            bottom: local_rect.bottom,
            left: local_rect.left,
            right: local_rect.right,
            top: local_rect.top,
        }),
        SceneGeometryV1::CubicPath { path } => cubic_path_local_bounds(path),
        SceneGeometryV1::Group {} | SceneGeometryV1::Line { .. } => None,
    }
}

fn fit_cubic_path_to_local_height_and_center(
    path: &CubicPathV1,
    source_bounds: &SceneEntityLocalBounds,
) -> Option<CubicPathV1> {
    let outline_bounds = cubic_path_local_bounds(path)?;
    let source_height = source_bounds.top - source_bounds.bottom;
    let outline_height = outline_bounds.top - outline_bounds.bottom;
    if !source_height.is_finite()
        || !outline_height.is_finite()
        || source_height <= 0.0
        || outline_height <= 0.0
    {
        return None;
    }
    let scale = source_height / outline_height;
    let source_center = PointV1 {
        x: source_bounds.left.midpoint(source_bounds.right),
        y: source_bounds.bottom.midpoint(source_bounds.top),
    };
    let outline_center = PointV1 {
        x: outline_bounds.left.midpoint(outline_bounds.right),
        y: outline_bounds.bottom.midpoint(outline_bounds.top),
    };
    if !scale.is_finite()
        || !source_center.x.is_finite()
        || !source_center.y.is_finite()
        || !outline_center.x.is_finite()
        || !outline_center.y.is_finite()
    {
        return None;
    }
    let transform = |point: &mut PointV1| {
        point.x = source_center.x + (point.x - outline_center.x) * scale;
        point.y = source_center.y + (point.y - outline_center.y) * scale;
    };
    let mut fitted = path.clone();
    for subpath in &mut fitted.subpaths {
        transform(&mut subpath.start);
        for segment in &mut subpath.segments {
            transform(&mut segment.control1);
            transform(&mut segment.control2);
            transform(&mut segment.end);
        }
    }
    Some(fitted)
}

fn close_transform_baseline_value(left: f64, right: f64) -> bool {
    left.is_finite()
        && right.is_finite()
        && (left - right).abs() <= 1.0e-9 * left.abs().max(right.abs()).max(1.0)
}

fn transform_is_uniform(left: f64, right: f64) -> bool {
    (left - right).abs() <= f64::EPSILON * left.abs().max(right.abs()).max(1.0) * 32.0
}

fn scene_entity_world_center(entity: &SceneEntityV1, bounds: &SceneEntityLocalBounds) -> PointV1 {
    let local_x = bounds.left.midpoint(bounds.right);
    let local_y = bounds.bottom.midpoint(bounds.top);
    PointV1 {
        x: entity.transform.m11 * local_x + entity.transform.m12 * local_y + entity.transform.tx,
        y: entity.transform.m21 * local_x + entity.transform.m22 * local_y + entity.transform.ty,
    }
}

fn positive_axis_aligned_transform(entity: &SceneEntityV1) -> bool {
    entity.transform.m11 > 0.0
        && entity.transform.m12 == 0.0
        && entity.transform.m21 == 0.0
        && entity.transform.m22 > 0.0
}

fn transform_baseline_matches(
    entity: &SceneEntityV1,
    expected: &TransformSceneEntityExpectedBaseline,
    bounds: &SceneEntityLocalBounds,
    actual_center: &PointV1,
) -> bool {
    if matches!(
        expected,
        TransformSceneEntityExpectedBaseline::CurrentCenter
    ) {
        return true;
    }
    if matches!(
        expected,
        TransformSceneEntityExpectedBaseline::CurrentUniformAffine
    ) {
        return positive_axis_aligned_transform(entity)
            && transform_is_uniform(entity.transform.m11, entity.transform.m22);
    }
    let expected_center = match expected {
        TransformSceneEntityExpectedBaseline::WorldSize { world_center, .. } => world_center,
        TransformSceneEntityExpectedBaseline::CurrentCenter
        | TransformSceneEntityExpectedBaseline::CurrentUniformAffine => unreachable!(),
    };
    if !expected_center.x.is_finite()
        || !expected_center.y.is_finite()
        || !close_transform_baseline_value(expected_center.x, actual_center.x)
        || !close_transform_baseline_value(expected_center.y, actual_center.y)
    {
        return false;
    }
    match expected {
        TransformSceneEntityExpectedBaseline::CurrentCenter
        | TransformSceneEntityExpectedBaseline::CurrentUniformAffine => unreachable!(),
        TransformSceneEntityExpectedBaseline::WorldSize { height, width, .. } => {
            width.is_finite()
                && height.is_finite()
                && *width > 0.0
                && *height > 0.0
                && matches!(
                    &entity.geometry,
                    SceneGeometryV1::Circle { .. }
                        | SceneGeometryV1::Rectangle { .. }
                        | SceneGeometryV1::CubicPath { .. }
                )
                && positive_axis_aligned_transform(entity)
                && close_transform_baseline_value(
                    *width,
                    (bounds.right - bounds.left) * entity.transform.m11,
                )
                && close_transform_baseline_value(
                    *height,
                    (bounds.top - bounds.bottom) * entity.transform.m22,
                )
        }
    }
}

#[allow(
    clippy::float_cmp,
    reason = "exact identity defines whether a transform intent contributes an effect"
)]
fn resolve_transform_intent(
    target: &SceneEntityV1,
    intent: TransformSceneEntityIntent,
) -> Result<(PointV1, Option<ScaleAboutPivot>), TransformSceneEntityError> {
    match intent {
        TransformSceneEntityIntent::Relative { delta, scale } => {
            if !delta.x.is_finite() || !delta.y.is_finite() {
                return Err(TransformSceneEntityError::InvalidDelta);
            }
            if let Some(scale) = &scale {
                if !scale.x_factor.is_finite()
                    || scale.x_factor <= 0.0
                    || !scale.y_factor.is_finite()
                    || scale.y_factor <= 0.0
                    || (scale.x_factor == 1.0 && scale.y_factor == 1.0)
                {
                    return Err(TransformSceneEntityError::InvalidFactor);
                }
                if !scale.pivot.x.is_finite() || !scale.pivot.y.is_finite() {
                    return Err(TransformSceneEntityError::InvalidPivot);
                }
            } else if delta.x == 0.0 && delta.y == 0.0 {
                return Err(TransformSceneEntityError::NoOp);
            }
            Ok((delta, scale))
        }
        TransformSceneEntityIntent::FromBaseline {
            expected_baseline,
            scale,
            target_center,
        } => {
            if target_center
                .as_ref()
                .is_some_and(|center| !center.x.is_finite() || !center.y.is_finite())
            {
                return Err(TransformSceneEntityError::InvalidTargetCenter);
            }
            if scale.as_ref().is_some_and(|scale| {
                !scale.x_factor.is_finite()
                    || scale.x_factor <= 0.0
                    || !scale.y_factor.is_finite()
                    || scale.y_factor <= 0.0
            }) {
                return Err(TransformSceneEntityError::InvalidFactor);
            }
            if target.parent_id.is_some() {
                return Err(TransformSceneEntityError::TargetIsNotRoot(
                    target.id.clone(),
                ));
            }
            let bounds = scene_entity_local_bounds(target)
                .ok_or(TransformSceneEntityError::BaselineUnavailable)?;
            let actual_center = scene_entity_world_center(target, &bounds);
            if !transform_baseline_matches(target, &expected_baseline, &bounds, &actual_center) {
                return Err(TransformSceneEntityError::BaselineMismatch);
            }
            let delta =
                target_center
                    .as_ref()
                    .map_or(PointV1 { x: 0.0, y: 0.0 }, |target_center| PointV1 {
                        x: target_center.x - actual_center.x,
                        y: target_center.y - actual_center.y,
                    });
            let scale = scale.and_then(|scale| {
                (scale.x_factor != 1.0 || scale.y_factor != 1.0).then_some(ScaleAboutPivot {
                    pivot: actual_center,
                    x_factor: scale.x_factor,
                    y_factor: scale.y_factor,
                })
            });
            if scale.is_none() && delta.x == 0.0 && delta.y == 0.0 {
                return Err(TransformSceneEntityError::NoOp);
            }
            Ok((delta, scale))
        }
    }
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
struct StudioProgramOperationFacts<'a> {
    depends_on: &'a [String],
    id: &'a str,
}

fn studio_program_source_seconds(
    source: &StudioProgramAnchorSource,
    captured_playhead: f64,
) -> Option<f64> {
    if !captured_playhead.is_finite() || captured_playhead < 0.0 {
        return None;
    }
    match source {
        StudioProgramAnchorSource::Absolute {
            seconds: Some(seconds),
        } if seconds.is_finite() && *seconds >= 0.0 => Some(*seconds),
        StudioProgramAnchorSource::Playhead {
            reference_seconds: Some(reference_seconds),
        } if reference_seconds.is_finite()
            && *reference_seconds >= 0.0
            && (*reference_seconds - captured_playhead).abs() < 0.001 =>
        {
            Some(*reference_seconds)
        }
        StudioProgramAnchorSource::Absolute { seconds: None }
        | StudioProgramAnchorSource::Playhead {
            reference_seconds: None,
        }
        | StudioProgramAnchorSource::Unsupported
        | StudioProgramAnchorSource::Absolute { .. }
        | StudioProgramAnchorSource::Playhead { .. } => None,
    }
}

fn studio_program_anchor_is_closed(
    source: &StudioProgramAnchorSource,
    captured_playhead: f64,
    resolved_seconds: f64,
    scene_duration: f64,
) -> bool {
    studio_program_source_seconds(source, captured_playhead).is_some_and(|source_seconds| {
        resolved_seconds.is_finite()
            && resolved_seconds >= 0.0
            && resolved_seconds <= scene_duration + TIMELINE_ANCHOR_EPSILON
            && studio_timeline_semantic_values_match(source_seconds, resolved_seconds)
    })
}

fn studio_program_structure_is_closed(
    operations: &[StudioProgramOperationFacts<'_>],
    requested_execution: StudioProgramExecution,
    schedule_edge_count: usize,
    schedule_mode: StudioProgramScheduleMode,
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
    if requested_execution == StudioProgramExecution::Sequence {
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
        StudioProgramExecution::Sequence => StudioProgramScheduleMode::Sequence,
        StudioProgramExecution::Parallel if expected_edge_count == 0 => {
            StudioProgramScheduleMode::Parallel
        }
        StudioProgramExecution::Parallel => StudioProgramScheduleMode::DependencyDag,
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

fn studio_motion_program_is_closed(program: &StudioMotionProgram) -> bool {
    let operations = program
        .operations
        .iter()
        .map(|operation| StudioProgramOperationFacts {
            depends_on: operation.depends_on(),
            id: operation.id(),
        })
        .collect::<Vec<_>>();
    program.intent_count == program.operations.len()
        && program.operations.iter().all(|operation| {
            matches!(operation, StudioMotionOperation::CreateMotion { .. })
                && operation.origin() == program.origin
        })
        && studio_program_structure_is_closed(
            &operations,
            program.requested_execution,
            program.schedule_edge_count,
            program.schedule_mode,
            &program.schedule_order,
            &[],
        )
}

fn studio_math_tex_transform_program_is_closed(program: &StudioMathTexTransformProgram) -> bool {
    let operations = program
        .operations
        .iter()
        .map(|operation| StudioProgramOperationFacts {
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
        && program.requested_execution == StudioProgramExecution::Sequence
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
        && studio_program_structure_is_closed(
            &operations,
            program.requested_execution,
            program.schedule_edge_count,
            program.schedule_mode,
            &program.schedule_order,
            &identity_edges,
        )
}

fn studio_math_tex_content_is_canonical(content: &StudioMathTexContent) -> bool {
    !content.display_lines.is_empty()
        && !content.tex_parts.is_empty()
        && content.tex_parts.iter().all(|part| !part.trim().is_empty())
}

fn studio_math_tex_transform_identity_is_closed(
    provisional: bool,
    entity_type: StudioAuthoringEntityKind,
    scale: Option<f64>,
    source_identity: Option<&str>,
) -> bool {
    !provisional
        && entity_type == StudioAuthoringEntityKind::MathTex
        && scale == Some(1.0)
        && source_identity.is_some_and(|identity| !identity.is_empty())
}

#[allow(
    clippy::too_many_lines,
    reason = "one small closed planner keeps projection and mutation admission identical"
)]
fn plan_studio_math_tex_transform_programs(
    base_duration: f64,
    programs: &[StudioMathTexTransformProgram],
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
            || !studio_program_anchor_is_closed(
                &program.anchor_source,
                program.anchor_captured_playhead,
                program.anchor_resolved_seconds,
                base_duration,
            )
            || !studio_math_tex_transform_program_is_closed(program)
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
                easing: motion.easing,
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
/// Returns `Unsupported` when the Programs, logical source, target identities, or lifetime do not
/// satisfy the same semantic planner used by Scene mutation.
pub fn project_studio_math_tex_transform_programs(
    base_duration: f64,
    programs: &[StudioMathTexTransformProgram],
    studio_entities: &[StudioMathTexTransformProjectionEntityIdentity],
) -> Result<StudioMathTexTransformProjection, ApplyStudioMathTexTransformEditError> {
    let existing_entity_ids = studio_entities
        .iter()
        .map(|entity| entity.object_graph_key.as_str())
        .collect::<BTreeSet<_>>();
    let plan =
        plan_studio_math_tex_transform_programs(base_duration, programs, &existing_entity_ids)?;
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

fn closed_studio_motion_operations(
    program: &StudioMotionProgram,
    scene_duration: f64,
) -> Option<Vec<&StudioMotionOperation>> {
    let mut operations = program
        .schedule_order
        .iter()
        .map(|operation_id| {
            program
                .operations
                .iter()
                .find(|operation| operation.id() == operation_id)
        })
        .collect::<Option<Vec<_>>>()?;
    if !program.lowering_supported
        || program.transaction_id.is_empty()
        || !studio_program_anchor_is_closed(
            &program.anchor_source,
            program.anchor_captured_playhead,
            program.anchor_resolved_seconds,
            scene_duration,
        )
        || !studio_motion_program_is_closed(program)
        || operations.iter().any(|operation| {
            !operation.interval().start.is_finite() || !operation.interval().end.is_finite()
        })
    {
        return None;
    }

    if program.requested_execution == StudioProgramExecution::Parallel {
        operations.sort_by(|left, right| left.interval().start.total_cmp(&right.interval().start));
    }
    let first = *operations.first()?;
    if (program.anchor_resolved_seconds - first.interval().start).abs() > TIMELINE_ANCHOR_EPSILON {
        return None;
    }

    match program.requested_execution {
        StudioProgramExecution::Sequence => {
            if operations.windows(2).any(|pair| {
                pair[1].interval().start < pair[0].interval().end - TIMELINE_ANCHOR_EPSILON
            }) {
                return None;
            }
        }
        StudioProgramExecution::Parallel => {
            let StudioMotionOperation::CreateMotion {
                easing, interval, ..
            } = first
            else {
                return None;
            };
            if program.schedule_mode != StudioProgramScheduleMode::Parallel {
                return None;
            }
            let mut bucket_start = interval.start;
            let mut bucket_end = interval.end;
            let mut bucket_easing = *easing;
            for operation in operations.iter().skip(1) {
                let StudioMotionOperation::CreateMotion {
                    easing: candidate_easing,
                    interval: candidate_interval,
                    ..
                } = operation
                else {
                    return None;
                };
                if (candidate_interval.start - bucket_start).abs() <= TIMELINE_ANCHOR_EPSILON {
                    if *candidate_easing != bucket_easing
                        || (candidate_interval.end - bucket_end).abs() > TIMELINE_ANCHOR_EPSILON
                    {
                        return None;
                    }
                    bucket_end = bucket_end.max(candidate_interval.end);
                } else {
                    if candidate_interval.start < bucket_end - TIMELINE_ANCHOR_EPSILON {
                        return None;
                    }
                    bucket_start = candidate_interval.start;
                    bucket_end = candidate_interval.end;
                    bucket_easing = *candidate_easing;
                }
            }
        }
    }
    Some(operations)
}

#[allow(
    clippy::too_many_lines,
    reason = "one bounded motion scheduler keeps full apply and snapshot-free projection on the same admission path"
)]
fn plan_studio_motion_programs(
    base_duration: f64,
    programs: &[StudioMotionProgram],
) -> Result<StudioMotionPlan, ProjectStudioMotionEditError> {
    if !base_duration.is_finite() || base_duration <= 0.0 || programs.is_empty() {
        return Err(ProjectStudioMotionEditError::Unsupported);
    }
    let mut ordered_programs = (0..programs.len()).collect::<Vec<_>>();
    ordered_programs.sort_by(|left, right| {
        programs[*left]
            .anchor_resolved_seconds
            .total_cmp(&programs[*right].anchor_resolved_seconds)
            .then(left.cmp(right))
    });
    let mut operation_ids = BTreeSet::new();
    let mut resolved_offset = 0.0;
    let mut projected_duration = base_duration;
    let mut motions = Vec::new();
    let mut insertions = Vec::with_capacity(programs.len());
    let mut timeline_insertions = Vec::with_capacity(programs.len());

    for program_index in ordered_programs {
        let program = &programs[program_index];
        let operations = closed_studio_motion_operations(program, base_duration)
            .ok_or(ProjectStudioMotionEditError::Unsupported)?;
        let mut maximum_end = program.anchor_resolved_seconds;
        let mut parallel_bucket_start: Option<f64> = None;
        let mut parallel_targets = BTreeSet::new();
        for operation in operations {
            if !operation_ids.insert(operation.id()) {
                return Err(ProjectStudioMotionEditError::Unsupported);
            }
            let StudioMotionOperation::CreateMotion {
                control_offset,
                delta,
                easing,
                interval,
                target_entity_ids,
                ..
            } = operation
            else {
                return Err(ProjectStudioMotionEditError::Unsupported);
            };
            let mut operation_targets = BTreeSet::new();
            if target_entity_ids.is_empty()
                || target_entity_ids
                    .iter()
                    .any(|target| target.is_empty() || !operation_targets.insert(target.as_str()))
                || !studio_authoring_point_is_finite(control_offset)
                || !studio_authoring_point_is_finite(delta)
                || (control_offset.x == 0.0
                    && control_offset.y == 0.0
                    && delta.x == 0.0
                    && delta.y == 0.0)
                || interval.start < 0.0
                || interval.start >= interval.end
                || interval.end > base_duration + TIMELINE_ANCHOR_EPSILON
            {
                return Err(ProjectStudioMotionEditError::Unsupported);
            }
            if program.requested_execution == StudioProgramExecution::Parallel {
                if parallel_bucket_start.is_none_or(|bucket_start| {
                    (interval.start - bucket_start).abs() > TIMELINE_ANCHOR_EPSILON
                }) {
                    parallel_bucket_start = Some(interval.start);
                    parallel_targets.clear();
                }
                if target_entity_ids
                    .iter()
                    .any(|target| !parallel_targets.insert(target.as_str()))
                {
                    return Err(ProjectStudioMotionEditError::Unsupported);
                }
            }
            maximum_end = maximum_end.max(interval.end);
            motions.push(PlannedStudioMotion {
                base_interval: interval.clone(),
                control_offset: control_offset.clone(),
                delta: delta.clone(),
                easing: *easing,
                interval: IntervalV1 {
                    end: interval.end + resolved_offset,
                    start: interval.start + resolved_offset,
                },
                operation_id: operation.id().to_owned(),
                parallel: program.requested_execution == StudioProgramExecution::Parallel,
                target_entity_ids: target_entity_ids.clone(),
                transaction_id: program.transaction_id.clone(),
            });
        }
        let duration = maximum_end - program.anchor_resolved_seconds;
        let at = program.anchor_resolved_seconds + resolved_offset;
        if !duration.is_finite()
            || duration <= 0.0
            || !at.is_finite()
            || at > projected_duration + TIMELINE_ANCHOR_EPSILON
        {
            return Err(ProjectStudioMotionEditError::Unsupported);
        }
        insertions.push(StudioMotionProjectionInsertion {
            at,
            duration,
            transaction_id: program.transaction_id.clone(),
        });
        timeline_insertions.push(SceneTimelineInsertion { at, duration });
        resolved_offset += duration;
        projected_duration += duration;
    }

    Ok(StudioMotionPlan {
        insertions,
        motions,
        projected_duration,
        timeline_insertions,
    })
}

#[derive(Clone, Debug)]
struct StudioMotionProjectionTarget {
    lifetime: IntervalV1,
    position: PointV1,
}

fn project_studio_motion_plan(
    plan: &StudioMotionPlan,
    mut targets: BTreeMap<String, StudioMotionProjectionTarget>,
) -> Result<StudioMotionProjection, ProjectStudioMotionEditError> {
    for target in targets.values_mut() {
        for insertion in &plan.timeline_insertions {
            shift_interval_for_insertion(&mut target.lifetime, insertion);
        }
    }
    let mut motions = Vec::new();
    for motion in &plan.motions {
        for target_entity_id in &motion.target_entity_ids {
            let target = targets
                .get_mut(target_entity_id)
                .ok_or(ProjectStudioMotionEditError::Unsupported)?;
            if motion.interval.start < target.lifetime.start - TIMELINE_ANCHOR_EPSILON
                || motion.interval.end > target.lifetime.end + TIMELINE_ANCHOR_EPSILON
            {
                return Err(ProjectStudioMotionEditError::Unsupported);
            }
            let from = target.position.clone();
            let to = PointV1 {
                x: from.x + motion.delta.x,
                y: from.y + motion.delta.y,
            };
            let control = PointV1 {
                x: from.x + motion.delta.x / 2.0 + motion.control_offset.x,
                y: from.y + motion.delta.y / 2.0 + motion.control_offset.y,
            };
            if !studio_authoring_point_is_finite(&from)
                || !studio_authoring_point_is_finite(&to)
                || !studio_authoring_point_is_finite(&control)
            {
                return Err(ProjectStudioMotionEditError::Unsupported);
            }
            target.position.clone_from(&to);
            motions.push(StudioProjectedMotion {
                control,
                control_offset: motion.control_offset.clone(),
                delta: motion.delta.clone(),
                easing: motion.easing,
                from,
                interval: motion.interval.clone(),
                operation_id: motion.operation_id.clone(),
                source_interval: motion.base_interval.clone(),
                target_entity_id: target_entity_id.clone(),
                to,
                transaction_id: motion.transaction_id.clone(),
            });
        }
    }
    Ok(StudioMotionProjection {
        insertions: plan.insertions.clone(),
        motions,
        projected_duration: plan.projected_duration,
    })
}

fn resolve_studio_motion_targets(
    target_entity_ids: &[String],
    studio_entities: &[StudioMotionEntityIdentity],
    source_runtime_bindings: &[StudioMotionSourceBinding],
) -> Option<Vec<String>> {
    let mut runtime_entity_ids = Vec::with_capacity(target_entity_ids.len());
    for studio_entity_id in target_entity_ids {
        let mut matching_entities = studio_entities
            .iter()
            .filter(|entity| entity.object_graph_key == *studio_entity_id);
        let entity = matching_entities
            .next()
            .filter(|entity| !entity.provisional && entity.source_identity.is_some())?;
        if matching_entities.next().is_some() {
            return None;
        }
        let source_identity = entity.source_identity.as_deref()?;
        let mut matching_bindings = source_runtime_bindings
            .iter()
            .filter(|binding| binding.source_identity_key == source_identity);
        let binding = matching_bindings
            .next()
            .filter(|binding| binding.source_name == source_identity)?;
        if matching_bindings.next().is_some() {
            return None;
        }
        runtime_entity_ids.push(binding.runtime_entity_id.clone());
    }
    Some(runtime_entity_ids)
}

#[allow(
    clippy::float_cmp,
    reason = "exact one is the normalized known-scale authority fact"
)]
fn resolve_imported_math_tex_transform_source(
    studio_entity_id: &str,
    studio_entities: &[StudioMathTexTransformEntityIdentity],
    source_runtime_bindings: &[StudioMathTexTransformSourceBinding],
) -> Option<(String, Option<PointV1>)> {
    let mut matching_entities = studio_entities
        .iter()
        .filter(|entity| entity.object_graph_key == studio_entity_id);
    let entity = matching_entities.next().filter(|entity| {
        studio_math_tex_transform_identity_is_closed(
            entity.provisional,
            entity.entity_type,
            entity.scale,
            entity.source_identity.as_deref(),
        )
    })?;
    if matching_entities.next().is_some() {
        return None;
    }
    let source_identity = entity.source_identity.as_deref()?;
    let mut matching_bindings = source_runtime_bindings
        .iter()
        .filter(|binding| binding.source_identity_key == source_identity);
    let binding = matching_bindings
        .next()
        .filter(|binding| binding.source_name == source_identity)?;
    if matching_bindings.next().is_some()
        || source_runtime_bindings
            .iter()
            .filter(|candidate| candidate.runtime_entity_id == binding.runtime_entity_id)
            .count()
            != 1
    {
        return None;
    }
    Some((binding.runtime_entity_id.clone(), entity.position.clone()))
}

#[derive(Clone, Debug, PartialEq)]
enum StudioBoundEntityEdit {
    Move(PointV1),
    Opacity(f64),
    Rotation(f64),
    UniformScale(f64),
}

impl StudioBoundEntityEdit {
    fn kind(&self) -> &'static str {
        match self {
            Self::Move(_) => "move",
            Self::Opacity(_) => "opacity",
            Self::Rotation(_) => "rotation",
            Self::UniformScale(_) => "resize",
        }
    }

    fn evidence(&self, phase: StudioBoundEntityEditPhase) -> String {
        match self {
            Self::Move(_) => format!(
                "Studio {} position request projected onto one verified source-bound root",
                phase.as_str()
            ),
            Self::Opacity(_) => "Studio construction-time absolute opacity request projected onto static vector paints in one verified source-bound root".to_owned(),
            Self::Rotation(_) => "Studio construction-time planar rotation request projected onto one verified source-bound root".to_owned(),
            Self::UniformScale(_) => format!(
                "Studio {} uniform resize request projected onto one verified source-bound root",
                phase.as_str()
            ),
        }
    }
}

fn studio_bound_entity_program_is_closed(program: &StudioBoundEntityProgram) -> bool {
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
    program: &StudioBoundEntityProgram,
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
        || !studio_bound_entity_program_is_closed(program)
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
            && (*to - *from - *relative_delta).abs() < 0.000_001
            && !rotation_is_noop(*relative_delta) =>
        {
            Some(StudioBoundEntityEdit::Rotation(*relative_delta))
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
            && twelve_significant_digits(*relative_factor) != Some(1.0)
            && close_transform_baseline_value(*to / *from, *relative_factor) =>
        {
            Some(StudioBoundEntityEdit::UniformScale(*relative_factor))
        }
        StudioBoundEntityOperation::Move { .. }
        | StudioBoundEntityOperation::Opacity { .. }
        | StudioBoundEntityOperation::Rotation { .. }
        | StudioBoundEntityOperation::UniformScale { .. }
        | StudioBoundEntityOperation::Unsupported { .. } => None,
    }
}

fn studio_creation_program_is_closed(program: &StudioCreationProgram) -> bool {
    let operations = program
        .operations
        .iter()
        .map(|operation| StudioProgramOperationFacts {
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
            | StudioCreationOperationKind::Resize { .. }
            | StudioCreationOperationKind::PersistentRemove { .. }
            | StudioCreationOperationKind::CreateMotion { .. }
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
        && studio_program_structure_is_closed(
            &operations,
            program.requested_execution,
            program.schedule_edge_count,
            program.schedule_mode,
            &program.schedule_order,
            &identity_edges,
        )
}

fn closed_studio_creation_motion_operations(
    program: &StudioCreationProgram,
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
    if !studio_creation_program_is_closed(program)
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

    if program.requested_execution == StudioProgramExecution::Parallel {
        operations.sort_by(|left, right| left.interval.start.total_cmp(&right.interval.start));
    }
    let first = *operations.first()?;
    if (program.anchor_resolved_seconds - first.interval.start).abs() > TIMELINE_ANCHOR_EPSILON {
        return None;
    }

    match program.requested_execution {
        StudioProgramExecution::Sequence => {
            if operations
                .windows(2)
                .any(|pair| pair[1].interval.start < pair[0].interval.end - TIMELINE_ANCHOR_EPSILON)
            {
                return None;
            }
        }
        StudioProgramExecution::Parallel => {
            let StudioCreationOperationKind::CreateMotion { easing, .. } = &first.kind else {
                return None;
            };
            if program.schedule_mode != StudioProgramScheduleMode::Parallel {
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

fn static_root_transform_program_is_closed(program: &StaticRootTransformProgram) -> bool {
    let operations = program
        .operations
        .iter()
        .map(|operation| StudioProgramOperationFacts {
            depends_on: &operation.depends_on,
            id: &operation.id,
        })
        .collect::<Vec<_>>();
    (1..=16).contains(&program.intent_count)
        && studio_program_structure_is_closed(
            &operations,
            program.requested_execution,
            program.schedule_edge_count,
            program.schedule_mode,
            &program.schedule_order,
            &[],
        )
}

fn static_root_motion_program(program: &StaticRootTransformProgram) -> Option<StudioMotionProgram> {
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
    Some(StudioMotionProgram {
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

fn one_projection_lifetime(lifetimes: &[IntervalV1]) -> Option<IntervalV1> {
    lifetimes
        .first()
        .filter(|lifetime| {
            lifetimes.len() == 1
                && lifetime.start.is_finite()
                && lifetime.end.is_finite()
                && lifetime.start < lifetime.end
        })
        .cloned()
}

fn project_standalone_motion_programs(
    base_duration: f64,
    programs: &[StudioMotionProgram],
    studio_entities: &[StudioMotionProjectionEntityIdentity],
) -> Result<StudioMotionProjection, ProjectStudioMotionEditError> {
    let plan = plan_studio_motion_programs(base_duration, programs)?;
    let target_ids = plan
        .motions
        .iter()
        .flat_map(|motion| motion.target_entity_ids.iter())
        .collect::<BTreeSet<_>>();
    let mut targets = BTreeMap::new();
    for target_id in target_ids {
        let mut matching = studio_entities
            .iter()
            .filter(|entity| entity.identity.object_graph_key == *target_id);
        let entity = matching
            .next()
            .filter(|entity| {
                !entity.identity.provisional
                    && entity
                        .identity
                        .source_identity
                        .as_deref()
                        .is_some_and(|identity| !identity.is_empty())
            })
            .filter(|_| matching.next().is_none())
            .ok_or(ProjectStudioMotionEditError::Unsupported)?;
        let position = entity.position.clone();
        if !studio_authoring_point_is_finite(&position) {
            return Err(ProjectStudioMotionEditError::Unsupported);
        }
        let lifetime = one_projection_lifetime(&entity.lifetime)
            .ok_or(ProjectStudioMotionEditError::Unsupported)?;
        targets.insert(
            target_id.clone(),
            StudioMotionProjectionTarget { lifetime, position },
        );
    }
    project_studio_motion_plan(&plan, targets)
}

#[allow(
    clippy::float_cmp,
    clippy::too_many_lines,
    reason = "exact zero and normalized scale are closed Studio authority facts; the bounded family admission stays atomic"
)]
fn project_static_root_motion_programs(
    base_duration: f64,
    programs: &[StaticRootTransformProgram],
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
                || !studio_program_anchor_is_closed(
                    &program.anchor_source,
                    program.anchor_captured_playhead,
                    program.anchor_resolved_seconds,
                    base_duration,
                )
                || !static_root_transform_program_is_closed(program)
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
                static_root_motion_program(program)
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

    let plan = plan_studio_motion_programs(base_duration, &motion_programs)?;
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
        } => project_standalone_motion_programs(command.base_duration, programs, studio_entities),
        StudioMotionProjectionBatch::StaticRoot {
            programs,
            studio_entities,
        } => project_static_root_motion_programs(command.base_duration, programs, studio_entities),
    }
}

struct PlannedStudioCreationEntity {
    create_operation_id: String,
    creation_transaction_id: String,
    creation_program_rank: usize,
    current_dimensions: StudioAuthoringDimensions,
    fade_interval: Option<IntervalV1>,
    initial_dimensions: StudioAuthoringDimensions,
    initial_position: PointV1,
    instant_at: Option<f64>,
    has_position_or_resize_instant: bool,
    kind: StudioAuthoringEntityKind,
    lifetime: IntervalV1,
    persistent_removal: Option<PersistentSceneRemoval>,
    position: PointV1,
    scale: f64,
    spec: StudioCreationEntitySpec,
}

struct StudioCreationTimelinePlan {
    insertions: Vec<StudioMotionProjectionInsertion>,
    offsets: Vec<f64>,
    ordered_programs: Vec<usize>,
    projected_duration: f64,
    ranked_insertions: Vec<(usize, SceneTimelineInsertion)>,
    ranks: Vec<usize>,
}

fn studio_creation_insertion_duration(program: &StudioCreationProgram) -> f64 {
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
    programs: &[StudioCreationProgram],
) -> Result<StudioCreationTimelinePlan, ProjectStudioCreationEditError> {
    if !base_duration.is_finite()
        || base_duration <= 0.0
        || programs.is_empty()
        || programs.iter().any(|program| {
            !program.lowering_supported
                || program.transaction_id.is_empty()
                || !studio_program_anchor_is_closed(
                    &program.anchor_source,
                    program.anchor_captured_playhead,
                    program.anchor_resolved_seconds,
                    base_duration,
                )
                || !studio_creation_program_is_closed(program)
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
    motion_projection: StudioMotionProjection,
    mutations: Vec<StudioCreationProjectedMutation>,
    timeline_insertions: Vec<SceneTimelineInsertion>,
}

impl StudioCreationPlan {
    fn projection(&self) -> StudioCreationProjection {
        let entities = self
            .entities
            .iter()
            .map(|state| StudioProjectedCreationEntity {
                created_lifetime: state.lifetime.clone(),
                entity_id: state.spec.id.clone(),
                initial_dimensions: state.initial_dimensions,
                initial_scale: 1.0,
                kind: state.kind,
                operation_id: state.create_operation_id.clone(),
                tex_parts: state.spec.tex_parts.clone(),
                transaction_id: state.creation_transaction_id.clone(),
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

#[allow(
    clippy::float_cmp,
    clippy::too_many_lines,
    reason = "one creation planner owns complete batch admission, ordering, and logical state"
)]
fn plan_studio_creation_programs(
    base_duration: f64,
    programs: &[StudioCreationProgram],
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
    let followup_programs = timeline
        .ordered_programs
        .iter()
        .copied()
        .filter(|index| !create_programs.contains(index))
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
                StudioCreationOperationKind::UniformScale { .. }
                | StudioCreationOperationKind::Resize { .. }
                | StudioCreationOperationKind::PersistentRemove { .. }
                | StudioCreationOperationKind::CreateMotion { .. }
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
                    if operation
                        .entity_id
                        .as_deref()
                        .is_some_and(|entity_id| scheduled_created_ids.contains(entity_id)) => {}
                StudioCreationOperationKind::Position { .. }
                | StudioCreationOperationKind::FadeIn { .. }
                | StudioCreationOperationKind::UniformScale { .. }
                | StudioCreationOperationKind::Resize { .. }
                | StudioCreationOperationKind::PersistentRemove { .. }
                | StudioCreationOperationKind::CreateMotion { .. }
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
                    StudioAuthoringEntityKind::Circle
                        | StudioAuthoringEntityKind::Line
                        | StudioAuthoringEntityKind::MathTex
                        | StudioAuthoringEntityKind::Rectangle
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
        let creation_payload_is_valid = match spec.kind {
            StudioAuthoringEntityKind::Circle | StudioAuthoringEntityKind::Rectangle => {
                spec.tex_parts.is_none()
                    && studio_authoring_shape_size(spec.kind, spec.dimensions).is_some()
            }
            StudioAuthoringEntityKind::Line => {
                spec.tex_parts.is_none() && spec.dimensions == StudioAuthoringDimensions::default()
            }
            StudioAuthoringEntityKind::MathTex => spec.tex_parts.as_ref().is_some_and(|parts| {
                !parts.is_empty() && parts.iter().all(|part| !part.trim().is_empty())
            }),
            StudioAuthoringEntityKind::Image | StudioAuthoringEntityKind::Other => false,
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
            create_operation_id: create_operation.id.clone(),
            creation_program_rank: program_rank,
            creation_transaction_id: program.transaction_id.clone(),
            current_dimensions: spec.dimensions,
            fade_interval,
            has_position_or_resize_instant: false,
            initial_dimensions: spec.dimensions,
            initial_position: initial_position.clone(),
            instant_at: None,
            kind: spec.kind,
            lifetime,
            persistent_removal: None,
            position: initial_position.clone(),
            scale: 1.0,
            spec: spec.clone(),
        });
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
                if program.requested_execution == StudioProgramExecution::Parallel
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
                        || (program.requested_execution == StudioProgramExecution::Parallel
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
                    parallel: program.requested_execution == StudioProgramExecution::Parallel,
                    target_entity_ids: target_entity_ids.clone(),
                    transaction_id: program.transaction_id.clone(),
                });
            }
            continue;
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
                | StudioCreationOperationKind::Resize { .. }
                | StudioCreationOperationKind::PersistentRemove { .. }
                | StudioCreationOperationKind::CreateMotion { .. }
                | StudioCreationOperationKind::Unsupported => {
                    return Err(ProjectStudioCreationEditError::Unsupported);
                }
            }
        }
    }

    for state in &entities {
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
    for motion in &planned_motions {
        for entity_id in &motion.target_entity_ids {
            let state = entities
                .iter()
                .find(|state| state.spec.id == *entity_id)
                .ok_or(ProjectStudioCreationEditError::Unsupported)?;
            if !studio_creation_motion_is_compatible(state, &motion.interval) {
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

/// Projects one complete supported Studio creation batch without a Scene snapshot.
///
/// # Errors
///
/// Returns `Unsupported` when the complete normalized batch is outside the closed creation subset.
pub fn project_studio_creation_programs(
    base_duration: f64,
    programs: &[StudioCreationProgram],
) -> Result<StudioCreationProjection, ProjectStudioCreationEditError> {
    Ok(plan_studio_creation_programs(base_duration, programs)?.projection())
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

fn resolve_static_root_binding<'a>(
    scene: &'a poietra_scene_ir::SceneIrV1,
    studio_entities: &'a [StaticRootTransformStudioEntity],
    source_runtime_bindings: &'a [StaticRootTransformSourceBinding],
    studio_entity_id: &str,
) -> Option<(&'a StaticRootTransformStudioEntity, &'a SceneEntityV1)> {
    let mut matching_studio_entities = studio_entities.iter().filter(|entity| {
        entity.object_graph_key == studio_entity_id && entity.id == studio_entity_id
    });
    let studio_entity = matching_studio_entities.next().filter(|entity| {
        !entity.provisional && entity.transaction_id.is_none() && entity.source_identity.is_some()
    })?;
    if matching_studio_entities.next().is_some() {
        return None;
    }
    let source_identity = studio_entity.source_identity.as_deref()?;
    let mut matching_bindings = source_runtime_bindings
        .iter()
        .filter(|binding| binding.source_identity_key == source_identity);
    let binding = matching_bindings
        .next()
        .filter(|binding| binding.source_name == source_identity)?;
    if matching_bindings.next().is_some()
        || source_runtime_bindings
            .iter()
            .filter(|candidate| candidate.runtime_entity_id == binding.runtime_entity_id)
            .count()
            != 1
    {
        return None;
    }
    let runtime_entity = scene
        .entities
        .iter()
        .find(|entity| entity.id == binding.runtime_entity_id)?;
    Some((studio_entity, runtime_entity))
}

#[allow(
    clippy::float_cmp,
    reason = "exact equality defines uniform and identity scale in the authoring command"
)]
fn validate_timed_transform_command(
    scene: &poietra_scene_ir::SceneIrV1,
    command: &TransformSceneEntityAtTimeCommand,
) -> Result<(), TransformSceneEntityError> {
    if scene.source.revision_hash() != command.expected_base_revision {
        return Err(TransformSceneEntityError::StaleBaseRevision);
    }
    if command.next_revision == command.expected_base_revision {
        return Err(TransformSceneEntityError::RevisionDidNotAdvance);
    }
    if !command.at.is_finite() || command.at < 0.0 || command.at >= scene.duration {
        return Err(TransformSceneEntityError::InvalidAnchor);
    }
    if !command.delta.x.is_finite() || !command.delta.y.is_finite() {
        return Err(TransformSceneEntityError::InvalidDelta);
    }
    if let Some(scale) = &command.scale {
        if !scale.x_factor.is_finite()
            || scale.x_factor <= 0.0
            || !scale.y_factor.is_finite()
            || scale.y_factor <= 0.0
            || scale.x_factor == 1.0
        {
            return Err(TransformSceneEntityError::InvalidFactor);
        }
        if scale.x_factor != scale.y_factor {
            return Err(TransformSceneEntityError::NonUniformFactor);
        }
        if !scale.pivot.x.is_finite() || !scale.pivot.y.is_finite() {
            return Err(TransformSceneEntityError::InvalidPivot);
        }
    } else if command.delta.x == 0.0 && command.delta.y == 0.0 {
        return Err(TransformSceneEntityError::NoOp);
    }
    if command.provenance.origin != ProvenanceOriginV1::StudioEditProgram {
        return Err(TransformSceneEntityError::InvalidProvenanceOrigin);
    }
    if scene
        .provenance
        .iter()
        .any(|record| record.id == command.provenance.id)
    {
        return Err(TransformSceneEntityError::ProvenanceConflict(
            command.provenance.id.clone(),
        ));
    }
    Ok(())
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

fn created_geometry_and_appearance(
    geometry: CreateSceneEntityGeometry,
) -> (SceneGeometryV1, SceneAppearanceV1, SceneCapabilityV1) {
    match geometry {
        CreateSceneEntityGeometry::Circle { radius } => (
            SceneGeometryV1::Circle {
                center: PointV1 { x: 0.0, y: 0.0 },
                radius,
            },
            studio_shape_appearance(),
            SceneCapabilityV1::ShapePrimitives,
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
        CreateSceneEntityGeometry::MathTex { path } => (
            SceneGeometryV1::CubicPath { path },
            studio_math_tex_appearance(),
            SceneCapabilityV1::CubicPathGeometry,
        ),
    }
}

fn shift_interval_for_insertion(interval: &mut IntervalV1, insertion: &SceneTimelineInsertion) {
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

fn insert_scene_time(scene: &mut poietra_scene_ir::SceneIrV1, insertion: &SceneTimelineInsertion) {
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
            | AnimationChannelV1::PathTrim { keyframes, .. }
            | AnimationChannelV1::MotionPath { keyframes, .. } => {
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

fn time_after_removal(time: f64, start: f64, end: f64) -> f64 {
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
            | AnimationChannelV1::PathTrim { keyframes, .. }
            | AnimationChannelV1::MotionPath { keyframes, .. } => {
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

fn studio_timeline_semantic_values_match(left: f64, right: f64) -> bool {
    left.is_finite()
        && right.is_finite()
        && (left - right).abs() <= 1e-9 * left.abs().max(right.abs()).max(1.0)
}

fn studio_timeline_intervals_overlap(left: &IntervalV1, right: &IntervalV1) -> bool {
    left.start < right.end
        && left.end > right.start
        && !studio_timeline_semantic_values_match(left.start, right.end)
        && !studio_timeline_semantic_values_match(left.end, right.start)
}

fn studio_timeline_program_is_closed(program: &StudioTimelineProgram) -> bool {
    let operations = program
        .operations
        .iter()
        .map(|operation| StudioProgramOperationFacts {
            depends_on: operation.depends_on(),
            id: operation.id(),
        })
        .collect::<Vec<_>>();
    program.intent_count == 1
        && program.operations.len() == 1
        && program.requested_execution == StudioProgramExecution::Sequence
        && studio_program_structure_is_closed(
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

fn validate_studio_timeline_programs(
    base_duration: f64,
    programs: &[StudioTimelineProgram],
) -> Result<(), ApplyStudioTimelineEditError> {
    if !base_duration.is_finite() || base_duration <= 0.0 || programs.is_empty() {
        return Err(ApplyStudioTimelineEditError::Unsupported);
    }
    let mut unique_operation_ids = BTreeSet::new();
    for program in programs {
        let StudioProgramAnchorSource::Absolute { seconds: Some(_) } = &program.anchor_source
        else {
            return Err(ApplyStudioTimelineEditError::Unsupported);
        };
        let Some(operation) = program.operations.first() else {
            return Err(ApplyStudioTimelineEditError::Unsupported);
        };
        if !studio_program_anchor_is_closed(
            &program.anchor_source,
            program.anchor_captured_playhead,
            program.anchor_resolved_seconds,
            base_duration,
        ) || program.transaction_id.is_empty()
            || !program.lowering_supported
            || program.origin != StudioAuthoringOrigin::StudioDefault
            || !studio_timeline_program_is_closed(program)
            || operation.origin() != StudioAuthoringOrigin::StudioDefault
            || operation.id().is_empty()
            || !unique_operation_ids.insert(operation.id())
        {
            return Err(ApplyStudioTimelineEditError::Unsupported);
        }
    }
    Ok(())
}

fn ordered_studio_timeline_programs(programs: &[StudioTimelineProgram]) -> Vec<(f64, usize)> {
    let mut ordered = programs
        .iter()
        .enumerate()
        .map(|(index, program)| {
            let StudioProgramAnchorSource::Absolute {
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

struct StudioTimelinePlanningState {
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
    fn new(base_duration: f64, program_count: usize) -> Self {
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

    fn project_program(
        &mut self,
        program: &StudioTimelineProgram,
        source_seconds: f64,
    ) -> Result<StudioTimelineProgramProjection, ApplyStudioTimelineEditError> {
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
        Ok(StudioTimelineProgramProjection {
            operation_id: operation.id().to_owned(),
            transaction_id: program.transaction_id.clone(),
            working_anchor,
            working_interval,
        })
    }

    fn finish(
        self,
        program_projections: Vec<StudioTimelineProgramProjection>,
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

fn plan_studio_timeline_programs(
    base_duration: f64,
    programs: &[StudioTimelineProgram],
) -> Result<StudioTimelinePlan, ApplyStudioTimelineEditError> {
    validate_studio_timeline_programs(base_duration, programs)?;
    let ordered_programs = ordered_studio_timeline_programs(programs);
    let mut program_projections = vec![None; programs.len()];
    let mut state = StudioTimelinePlanningState::new(base_duration, programs.len());
    for (source_seconds, program_index) in ordered_programs {
        program_projections[program_index] =
            Some(state.project_program(&programs[program_index], source_seconds)?);
    }
    let program_projections = program_projections
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or(ApplyStudioTimelineEditError::Unsupported)?;
    Ok(state.finish(program_projections))
}

/// Projects normalized timeline Programs without reading or mutating an Engine session.
///
/// # Errors
///
/// Returns the same closed-contract admission error used by timeline mutation.
pub fn project_studio_timeline_programs(
    base_duration: f64,
    programs: &[StudioTimelineProgram],
) -> Result<StudioTimelineProjection, ApplyStudioTimelineEditError> {
    Ok(plan_studio_timeline_programs(base_duration, programs)?.projection)
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
                || !step.scale_x.is_finite()
                || step.scale_x <= 0.0
                || !step.scale_y.is_finite()
                || step.scale_y <= 0.0)
        {
            return Err(CreateSceneEntitiesError::InvalidInstantTransform);
        }
    }
    Ok(())
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

#[derive(Clone, Debug)]
struct PlannedPersistentSceneRemoval {
    affected_entities: Vec<(usize, Vec<IntervalV1>)>,
    affected_entity_ids: Vec<String>,
    opacity_channel_index: Option<usize>,
    removal: PersistentSceneRemoval,
    root_entity_index: usize,
}

#[allow(
    clippy::too_many_lines,
    reason = "one plan pass must validate every subtree before the separate mutation pass begins"
)]
fn plan_persistent_scene_removals(
    scene: &poietra_scene_ir::SceneIrV1,
    removals: &[PersistentSceneRemoval],
) -> Result<Vec<PlannedPersistentSceneRemoval>, ApplyStudioPersistentRemoveError> {
    if removals.is_empty() {
        return Err(ApplyStudioPersistentRemoveError::EmptyBatch);
    }
    let entity_indexes = scene
        .entities
        .iter()
        .enumerate()
        .map(|(index, entity)| (entity.id.as_str(), index))
        .collect::<std::collections::HashMap<_, _>>();
    let mut children = vec![Vec::new(); scene.entities.len()];
    for (entity_index, entity) in scene.entities.iter().enumerate() {
        if let Some(parent_id) = entity.parent_id.as_deref() {
            let Some(&parent_index) = entity_indexes.get(parent_id) else {
                return Err(ApplyStudioPersistentRemoveError::TargetMissing(
                    parent_id.to_owned(),
                ));
            };
            children[parent_index].push(entity_index);
        }
    }
    let mut selected_targets = std::collections::BTreeMap::<usize, &str>::new();
    for removal in removals {
        let entity_index = entity_indexes
            .get(removal.entity_id.as_str())
            .copied()
            .ok_or_else(|| {
                ApplyStudioPersistentRemoveError::TargetMissing(removal.entity_id.clone())
            })?;
        if selected_targets
            .insert(entity_index, removal.entity_id.as_str())
            .is_some()
        {
            return Err(ApplyStudioPersistentRemoveError::DuplicateTarget(
                removal.entity_id.clone(),
            ));
        }
    }
    for (&entity_index, &target_id) in &selected_targets {
        let mut parent_id = scene.entities[entity_index].parent_id.as_deref();
        while let Some(id) = parent_id {
            let parent_index = entity_indexes
                .get(id)
                .copied()
                .ok_or_else(|| ApplyStudioPersistentRemoveError::TargetMissing(id.to_owned()))?;
            if let Some(ancestor_target) = selected_targets.get(&parent_index) {
                return Err(ApplyStudioPersistentRemoveError::OverlappingTargets(
                    (*ancestor_target).to_owned(),
                    target_id.to_owned(),
                ));
            }
            parent_id = scene.entities[parent_index].parent_id.as_deref();
        }
    }
    let mut planned = Vec::with_capacity(removals.len());
    for removal in removals {
        if !removal.interval.start.is_finite()
            || !removal.interval.end.is_finite()
            || removal.interval.start < 0.0
            || removal.interval.start > removal.interval.end
            || removal.interval.end > scene.duration
        {
            return Err(ApplyStudioPersistentRemoveError::InvalidInterval);
        }
        let entity_index = entity_indexes
            .get(removal.entity_id.as_str())
            .copied()
            .ok_or_else(|| {
                ApplyStudioPersistentRemoveError::TargetMissing(removal.entity_id.clone())
            })?;
        let mut affected_entity_indexes = Vec::new();
        let mut pending = vec![entity_index];
        while let Some(affected_index) = pending.pop() {
            affected_entity_indexes.push(affected_index);
            pending.extend(children[affected_index].iter().copied());
        }
        affected_entity_indexes.sort_unstable();
        if scene.entities[entity_index].parent_id.is_some() {
            return Err(ApplyStudioPersistentRemoveError::TargetIsNotRoot(
                removal.entity_id.clone(),
            ));
        }
        let root = &scene.entities[entity_index];
        if !root.lifetimes.iter().any(|lifetime| {
            removal.interval.start >= lifetime.start
                && removal.interval.start < lifetime.end
                && removal.interval.end > lifetime.start
                && removal.interval.end <= lifetime.end
        }) {
            return Err(ApplyStudioPersistentRemoveError::TargetInactive(
                root.id.clone(),
            ));
        }
        let affected_entity_ids = affected_entity_indexes
            .iter()
            .map(|&affected_index| scene.entities[affected_index].id.clone())
            .collect();
        let affected_entities = affected_entity_indexes
            .into_iter()
            .map(|affected_index| {
                let retained_lifetimes = scene.entities[affected_index]
                    .lifetimes
                    .iter()
                    .filter_map(|lifetime| {
                        if lifetime.start >= removal.interval.end {
                            return None;
                        }
                        Some(IntervalV1 {
                            end: lifetime.end.min(removal.interval.end),
                            start: lifetime.start,
                        })
                    })
                    .filter(|lifetime| lifetime.start < lifetime.end)
                    .collect();
                (affected_index, retained_lifetimes)
            })
            .collect();
        let opacity_channels = scene
            .animation_channels
            .iter()
            .enumerate()
            .filter_map(|(index, channel)| match channel {
                AnimationChannelV1::Opacity { entity_id, .. }
                    if entity_id == &removal.entity_id =>
                {
                    Some(index)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        if opacity_channels.len() > 1 {
            return Err(ApplyStudioPersistentRemoveError::OpacityAnimationConflict(
                removal.entity_id.clone(),
            ));
        }
        let opacity_channel_index = opacity_channels.first().copied();
        if removal.interval.end > removal.interval.start
            && let Some(channel_index) = opacity_channel_index
        {
            let AnimationChannelV1::Opacity { keyframes, .. } =
                &scene.animation_channels[channel_index]
            else {
                unreachable!();
            };
            let compatible = keyframes.last().is_some_and(|last| {
                last.easing_to_next.is_none()
                    && last.at <= removal.interval.start + TIMELINE_ANCHOR_EPSILON
                    && close_transform_baseline_value(last.value, 1.0)
            });
            if !compatible {
                return Err(ApplyStudioPersistentRemoveError::OpacityAnimationConflict(
                    removal.entity_id.clone(),
                ));
            }
        }
        planned.push(PlannedPersistentSceneRemoval {
            affected_entities,
            affected_entity_ids,
            opacity_channel_index,
            removal: removal.clone(),
            root_entity_index: entity_index,
        });
    }
    Ok(planned)
}

fn remove_scene_entities(
    scene: &mut poietra_scene_ir::SceneIrV1,
    removed_entity_ids: &BTreeSet<String>,
) {
    scene.animation_channels.retain(|channel| {
        channel
            .entity_id()
            .is_none_or(|entity_id| !removed_entity_ids.contains(entity_id))
    });
    scene
        .entities
        .retain(|entity| !removed_entity_ids.contains(&entity.id));
}

fn apply_persistent_scene_removals(
    scene: &mut poietra_scene_ir::SceneIrV1,
    removals: &[PersistentSceneRemoval],
    provenance_id: &str,
) -> Result<StudioPersistentRemoveProjection, ApplyStudioPersistentRemoveError> {
    let planned = plan_persistent_scene_removals(scene, removals)?;
    let mut removed_entity_ids = BTreeSet::new();
    for removal in &planned {
        for (entity_index, retained_lifetimes) in &removal.affected_entities {
            if retained_lifetimes.is_empty() {
                removed_entity_ids.insert(scene.entities[*entity_index].id.clone());
                continue;
            }
            let affected = &mut scene.entities[*entity_index];
            affected.lifetimes.clone_from(retained_lifetimes);
            provenance_id.clone_into(&mut affected.provenance_id);
        }
    }
    for removal in &planned {
        if removal.removal.interval.start >= removal.removal.interval.end {
            continue;
        }
        if let Some(channel_index) = removal.opacity_channel_index {
            let AnimationChannelV1::Opacity { keyframes, .. } =
                &mut scene.animation_channels[channel_index]
            else {
                unreachable!();
            };
            let last = keyframes
                .last_mut()
                .expect("persistent remove plan has a keyframe");
            if studio_timeline_semantic_values_match(last.at, removal.removal.interval.start) {
                last.at = removal.removal.interval.start;
                last.easing_to_next = Some(EasingV1::Smooth {});
            } else {
                last.easing_to_next = Some(EasingV1::Linear {});
                keyframes.push(KeyframeV1 {
                    at: removal.removal.interval.start,
                    easing_to_next: Some(EasingV1::Smooth {}),
                    value: 1.0,
                });
            }
            keyframes.push(KeyframeV1 {
                at: removal.removal.interval.end,
                easing_to_next: None,
                value: 0.0,
            });
        } else {
            let channel_id = unused_channel_id(
                scene,
                &format!("studio-persistent-remove-{}", removal.root_entity_index),
            );
            let entity_id = scene.entities[removal.root_entity_index].id.clone();
            scene.animation_channels.push(AnimationChannelV1::Opacity {
                entity_id,
                id: channel_id,
                keyframes: vec![
                    KeyframeV1 {
                        at: removal.removal.interval.start,
                        easing_to_next: Some(EasingV1::Smooth {}),
                        value: 1.0,
                    },
                    KeyframeV1 {
                        at: removal.removal.interval.end,
                        easing_to_next: None,
                        value: 0.0,
                    },
                ],
                provenance_id: provenance_id.to_owned(),
            });
        }
    }
    if !removed_entity_ids.is_empty() {
        remove_scene_entities(scene, &removed_entity_ids);
    }
    if planned
        .iter()
        .any(|removal| removal.removal.interval.start < removal.removal.interval.end)
    {
        let mut capabilities = scene
            .required_capabilities
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        capabilities.insert(SceneCapabilityV1::OpacityAnimation);
        scene.required_capabilities = capabilities.into_iter().collect();
    }
    Ok(StudioPersistentRemoveProjection {
        removals: planned
            .into_iter()
            .map(|planned| StudioPersistentRemoveProjectionEntry {
                affected_scene_entity_ids: planned.affected_entity_ids,
                fade_interval: (planned.removal.interval.start < planned.removal.interval.end)
                    .then_some(planned.removal.interval.clone()),
                operation_id: planned.removal.operation_id,
                removed_at: planned.removal.interval.end,
                resulting_lifetime_end: planned.removal.interval.end,
                scene_entity_id: planned.removal.entity_id,
                studio_entity_id: planned.removal.studio_entity_id,
                transaction_id: planned.removal.transaction_id,
            })
            .collect(),
    })
}

fn quadratic_motion_segment(
    start: &PointV1,
    delta: &PointV1,
    control_offset: &PointV1,
) -> CubicSegmentV1 {
    let control_offset_x = 2.0 * control_offset.x / 3.0;
    let control_offset_y = 2.0 * control_offset.y / 3.0;
    CubicSegmentV1 {
        control1: PointV1 {
            x: start.x + delta.x / 3.0 + control_offset_x,
            y: start.y + delta.y / 3.0 + control_offset_y,
        },
        control2: PointV1 {
            x: start.x + 2.0 * delta.x / 3.0 + control_offset_x,
            y: start.y + 2.0 * delta.y / 3.0 + control_offset_y,
        },
        end: PointV1 {
            x: start.x + delta.x,
            y: start.y + delta.y,
        },
    }
}

fn motion_easing(easing: StudioMotionEasing) -> EasingV1 {
    match easing {
        StudioMotionEasing::Linear => EasingV1::Linear {},
        StudioMotionEasing::Smooth => EasingV1::ManimSmooth {},
    }
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

fn stitched_motion_keyframes(
    start: &PointV1,
    segments: &[PlannedEntityMotionSegment],
) -> Result<Vec<KeyframeV1<f64>>, ApplyStudioMotionEditError> {
    let lengths = segments
        .iter()
        .scan(start.clone(), |segment_start, planned| {
            let length = manim_cubic_chord_length_v1(segment_start, &planned.segment);
            *segment_start = planned.segment.end.clone();
            Some(length)
        })
        .collect::<Vec<_>>();
    let total_length = lengths.iter().sum::<f64>();
    if !total_length.is_finite() || total_length <= 0.0 {
        return Err(ApplyStudioMotionEditError::InvalidMotion);
    }

    let mut cumulative_length = 0.0;
    let mut keyframes: Vec<KeyframeV1<f64>> = Vec::with_capacity(segments.len() * 2);
    for (index, (planned, length)) in segments.iter().zip(lengths).enumerate() {
        let start_progress = cumulative_length / total_length;
        if let Some(previous) = keyframes.last_mut() {
            if planned.interval.start < previous.at - TIMELINE_ANCHOR_EPSILON {
                return Err(ApplyStudioMotionEditError::InvalidInterval);
            }
            if planned.interval.start > previous.at + TIMELINE_ANCHOR_EPSILON {
                previous.easing_to_next = Some(EasingV1::Linear {});
                keyframes.push(KeyframeV1 {
                    at: planned.interval.start,
                    easing_to_next: Some(motion_easing(planned.easing)),
                    value: start_progress,
                });
            } else {
                previous.easing_to_next = Some(motion_easing(planned.easing));
            }
        } else {
            keyframes.push(KeyframeV1 {
                at: planned.interval.start,
                easing_to_next: Some(motion_easing(planned.easing)),
                value: 0.0,
            });
        }
        cumulative_length += length;
        keyframes.push(KeyframeV1 {
            at: planned.interval.end,
            easing_to_next: None,
            value: if index + 1 == segments.len() {
                1.0
            } else {
                cumulative_length / total_length
            },
        });
    }
    Ok(keyframes)
}

fn append_planned_scene_motions(
    scene: &mut poietra_scene_ir::SceneIrV1,
    motions: &[PlannedSceneMotion],
    provenance_id: &str,
) -> Result<(), ApplyStudioMotionEditError> {
    if motions.is_empty() {
        return Ok(());
    }
    let mut entity_order = Vec::new();
    let mut entity_paths = BTreeMap::<String, PlannedEntityMotionPath>::new();
    for motion in motions {
        for entity_id in &motion.target_entity_ids {
            if !entity_paths.contains_key(entity_id) {
                let entity = scene
                    .entities
                    .iter()
                    .find(|entity| entity.id == *entity_id)
                    .ok_or_else(|| ApplyStudioMotionEditError::TargetMissing(entity_id.clone()))?;
                let start = PointV1 {
                    x: entity.transform.tx,
                    y: entity.transform.ty,
                };
                entity_order.push(entity_id.clone());
                entity_paths.insert(
                    entity_id.clone(),
                    PlannedEntityMotionPath {
                        current: start.clone(),
                        segments: Vec::new(),
                        start,
                    },
                );
            }
            let path = entity_paths
                .get_mut(entity_id)
                .ok_or_else(|| ApplyStudioMotionEditError::TargetMissing(entity_id.clone()))?;
            let segment =
                quadratic_motion_segment(&path.current, &motion.delta, &motion.control_offset);
            path.current = segment.end.clone();
            path.segments.push(PlannedEntityMotionSegment {
                easing: motion.easing,
                interval: motion.interval.clone(),
                segment,
            });
        }
    }

    for entity_id in entity_order {
        let path = entity_paths
            .remove(&entity_id)
            .ok_or_else(|| ApplyStudioMotionEditError::TargetMissing(entity_id.clone()))?;
        let channel_id = unused_channel_id(scene, "studio-motion");
        scene
            .animation_channels
            .push(AnimationChannelV1::MotionPath {
                entity_id,
                id: channel_id,
                keyframes: stitched_motion_keyframes(&path.start, &path.segments)?,
                orient_to_path: false,
                parameterization: Some(MotionPathParameterizationV1::ManimPointFromProportionV1),
                path: CubicPathV1 {
                    subpaths: vec![CubicSubpathV1 {
                        closed: false,
                        segments: path
                            .segments
                            .into_iter()
                            .map(|planned| planned.segment)
                            .collect(),
                        start: path.start,
                    }],
                },
                provenance_id: provenance_id.to_owned(),
            });
    }
    let mut capabilities = scene
        .required_capabilities
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    capabilities.insert(SceneCapabilityV1::MotionPathAnimation);
    scene.required_capabilities = capabilities.into_iter().collect();
    Ok(())
}

#[allow(
    clippy::float_cmp,
    reason = "exact zero distinguishes a visible motion command from a no-op"
)]
fn validate_create_scene_motion_command(
    scene: &poietra_scene_ir::SceneIrV1,
    command: &CreateSceneMotionCommand,
) -> Result<Vec<(String, PointV1)>, ApplyStudioMotionEditError> {
    if scene.source.revision_hash() != command.expected_base_revision {
        return Err(ApplyStudioMotionEditError::StaleBaseRevision);
    }
    if command.next_revision == command.expected_base_revision {
        return Err(ApplyStudioMotionEditError::RevisionDidNotAdvance);
    }
    if !command.interval.start.is_finite()
        || !command.interval.end.is_finite()
        || command.interval.start < 0.0
        || command.interval.start >= command.interval.end
        || command.interval.end > scene.duration
    {
        return Err(ApplyStudioMotionEditError::InvalidInterval);
    }
    if !command.delta.x.is_finite()
        || !command.delta.y.is_finite()
        || !command.control_offset.x.is_finite()
        || !command.control_offset.y.is_finite()
        || (command.delta.x == 0.0
            && command.delta.y == 0.0
            && command.control_offset.x == 0.0
            && command.control_offset.y == 0.0)
    {
        return Err(ApplyStudioMotionEditError::InvalidMotion);
    }
    if command.target_entity_ids.is_empty() {
        return Err(ApplyStudioMotionEditError::EmptyTargets);
    }
    let mut unique_targets = BTreeSet::new();
    for entity_id in &command.target_entity_ids {
        if !unique_targets.insert(entity_id.as_str()) {
            return Err(ApplyStudioMotionEditError::DuplicateTarget(
                entity_id.clone(),
            ));
        }
    }
    if scene
        .provenance
        .iter()
        .any(|record| record.id == command.provenance.id)
    {
        return Err(ApplyStudioMotionEditError::ProvenanceConflict(
            command.provenance.id.clone(),
        ));
    }

    let mut target_starts = Vec::with_capacity(command.target_entity_ids.len());
    for entity_id in &command.target_entity_ids {
        let target = scene
            .entities
            .iter()
            .find(|entity| entity.id == *entity_id)
            .ok_or_else(|| ApplyStudioMotionEditError::TargetMissing(entity_id.clone()))?;
        if target.parent_id.is_some() {
            return Err(ApplyStudioMotionEditError::TargetIsNotRoot(
                entity_id.clone(),
            ));
        }
        if !target.lifetimes.iter().any(|lifetime| {
            command.interval.start >= lifetime.start && command.interval.end <= lifetime.end
        }) {
            return Err(ApplyStudioMotionEditError::TargetInactive(
                entity_id.clone(),
            ));
        }
        if has_animated_transform(scene, entity_id) {
            return Err(ApplyStudioMotionEditError::AnimatedTransformUnsupported(
                entity_id.clone(),
            ));
        }
        target_starts.push((
            entity_id.clone(),
            PointV1 {
                x: target.transform.tx,
                y: target.transform.ty,
            },
        ));
    }
    Ok(target_starts)
}

fn append_created_entity(
    scene: &mut poietra_scene_ir::SceneIrV1,
    entity: CreateSceneEntity,
    provenance_id: &str,
    scene_order: u32,
    source_z_index: f64,
    capabilities: &mut BTreeSet<SceneCapabilityV1>,
) {
    let (geometry, appearance, capability) = created_geometry_and_appearance(entity.geometry);
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
        appearance,
        geometry,
        id: created_id.clone(),
        lifetimes: vec![lifetime.clone()],
        parent_id: None,
        provenance_id: provenance_id.to_owned(),
        scene_order,
        source_z_index,
        transform: base_transform,
    });
    if let Some(fade) = entity.fade_in {
        capabilities.insert(SceneCapabilityV1::OpacityAnimation);
        let channel_id_prefix = format!("studio-opacity-{scene_order}");
        let channel_id = unused_channel_id(scene, &channel_id_prefix);
        scene.animation_channels.push(AnimationChannelV1::Opacity {
            entity_id: created_id.clone(),
            id: channel_id,
            keyframes: vec![
                KeyframeV1 {
                    at: lifetime.start,
                    easing_to_next: Some(EasingV1::Smooth {}),
                    value: 0.0,
                },
                KeyframeV1 {
                    at: fade.end,
                    easing_to_next: None,
                    value: 1.0,
                },
            ],
            provenance_id: provenance_id.to_owned(),
        });
    }
    if let Some(step) = entity.instant_transform {
        capabilities.insert(SceneCapabilityV1::AffineTransformAnimation);
        let value = AffineTransformV1 {
            m11: step.scale_x,
            m12: 0.0,
            m21: 0.0,
            m22: step.scale_y,
            tx: step.position.x,
            ty: step.position.y,
        };
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
}

impl EngineSessionV1 {
    /// Authorizes normalized Studio duration Programs and applies them atomically.
    ///
    /// Source anchors are ordered stably and rebased through earlier waits and trims before the
    /// existing Scene timeline primitive is invoked. The caller must send every Program and map
    /// every non-timeline operation to `Unsupported`; this method owns admission of the complete
    /// edit.
    ///
    /// # Errors
    ///
    /// Returns `Unsupported` when the normalized Programs do not describe the closed static
    /// imported-Scene duration subset, or the timeline primitive error when mutation fails.
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
        ) || !scene.animation_channels.is_empty()
        {
            return Err(ApplyStudioTimelineEditError::Unsupported);
        }
        let plan = plan_studio_timeline_programs(scene.duration, &programs)?;

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

    fn create_scene_entities(
        &mut self,
        command: CreateSceneEntitiesCommand,
    ) -> Result<StudioAuthoringEditResult, CreateSceneEntitiesError> {
        validate_create_scene_entities_command(self, &command)?;

        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        let creates_math_tex = command
            .entities
            .iter()
            .any(|entity| matches!(&entity.geometry, CreateSceneEntityGeometry::MathTex { .. }));
        for insertion in &command.timeline_insertions {
            insert_scene_time(&mut candidate.scene, insertion);
        }
        if creates_math_tex && matches!(candidate.scene.fidelity, FidelityV1::Exact {}) {
            candidate.scene.fidelity = FidelityV1::Approximate {
                evidence: vec![
                    "Studio MathTex uses a browser-compiled outline without exact Manim parity evidence."
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

        for (scene_order, entity) in (first_scene_order..).zip(command.entities) {
            append_created_entity(
                &mut candidate.scene,
                entity,
                &command.provenance.id,
                scene_order,
                source_z_index,
                &mut capabilities,
            );
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

    /// Authorizes complete normalized Studio creation Programs and applies one atomic batch.
    ///
    /// # Errors
    ///
    /// Returns `Unsupported` when the normalized Programs do not describe the supported
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
        let plan = plan_studio_creation_programs(self.scene().duration, &programs)
            .map_err(|_| ApplyStudioCreationEditError::Unsupported)?;
        for state in &plan.entities {
            if state.kind == StudioAuthoringEntityKind::MathTex
                && math_tex_outlines
                    .iter()
                    .filter(|outline| {
                        outline.entity_id == state.spec.id
                            && Some(&outline.tex_parts) == state.spec.tex_parts.as_ref()
                    })
                    .count()
                    != 1
            {
                return Err(ApplyStudioCreationEditError::Unsupported);
            }
        }

        let mut entities = Vec::with_capacity(plan.entities.len());
        let mut persistent_removals = Vec::new();
        for state in &plan.entities {
            let geometry = match state.kind {
                StudioAuthoringEntityKind::Circle => {
                    let size = studio_authoring_shape_size(state.kind, state.initial_dimensions)
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    CreateSceneEntityGeometry::Circle {
                        radius: size.width / 2.0,
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
                    CreateSceneEntityGeometry::MathTex {
                        path: outline.path.clone(),
                    }
                }
                StudioAuthoringEntityKind::Image | StudioAuthoringEntityKind::Other => {
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
                    StudioAuthoringEntityKind::Line | StudioAuthoringEntityKind::MathTex => {
                        (1.0, 1.0)
                    }
                    StudioAuthoringEntityKind::Image | StudioAuthoringEntityKind::Other => {
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
                    scale_x: state.scale * x_ratio,
                    scale_y: state.scale * y_ratio,
                })
            } else {
                None
            };
            if let Some(removal) = &state.persistent_removal {
                persistent_removals.push(removal.clone());
            }
            entities.push(CreateSceneEntity {
                fade_in: state
                    .fade_interval
                    .as_ref()
                    .map(|interval| CreateSceneEntityFadeIn { end: interval.end }),
                geometry,
                id: state.spec.id.clone(),
                instant_transform,
                lifetime: state.lifetime.clone(),
                position: studio_point_to_scene_point(
                    &state.initial_position,
                    frame,
                    viewport,
                    &self.scene().camera.view.center,
                ),
                scale: 1.0,
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
                easing: motion.easing,
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
            motions,
            next_revision: next_revision.clone(),
            persistent_removals,
            provenance: ProvenanceRecordV1 {
                evidence: vec![format!(
                    "{} validated Studio Program(s) with {operation_count} operation(s) lowered as one atomic creation/motion/transform/persistent-remove core command",
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

    /// Authorizes one complete normalized Studio edit of one verified bound Scene root.
    ///
    /// Integration supplies every normalized Program and every candidate it has independently
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
    ) -> Result<SceneIrBundleV1, ApplyStudioBoundEntityEditError> {
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

        match edit {
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
            StudioBoundEntityEdit::UniformScale(factor) => {
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
            StudioBoundEntityEdit::Rotation(angle_radians) => self
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
        }
    }

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
        let plan = plan_studio_math_tex_transform_programs(
            scene.duration,
            &programs,
            &existing_entity_ids,
        )?;
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
            || program.requested_execution != StudioProgramExecution::Parallel
            || !static_root_transform_program_is_closed(program)
            || !studio_program_anchor_is_closed(
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
                mutations: vec![StudioStaticRootProjectedMutation {
                    mutation: StudioStaticRootMutation::MathTexContent {
                        content: content.clone(),
                        entity_id: entity_id.to_owned(),
                        interval: operation.interval.clone(),
                    },
                    operation_id: operation.id.clone(),
                    transaction_id: program.transaction_id.clone(),
                }],
            }),
        };
        self.replace_snapshot(candidate)?;
        Ok(result)
    }

    /// Authorizes complete normalized Studio motion Programs and applies them atomically.
    ///
    /// The caller sends every Program and operation. This method owns closed-subset admission,
    /// Studio-to-runtime identity resolution, viewport conversion, and provenance construction.
    ///
    /// # Errors
    ///
    /// Returns `Unsupported` when the normalized edit is outside the imported static motion
    /// subset, or a concrete motion mutation error. Every failure preserves the installed Scene.
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "frame dimensions are exact normalized authority facts; closed batch admission stays contiguous before the single commit"
    )]
    pub fn apply_studio_motion_edit(
        &mut self,
        command: ApplyStudioMotionEditCommand,
    ) -> Result<SceneIrBundleV1, ApplyStudioMotionEditError> {
        let ApplyStudioMotionEditCommand {
            expected_base_revision,
            frame,
            next_revision,
            programs,
            source_runtime_bindings,
            studio_entities,
            viewport,
        } = command;
        let scene = self.scene();
        if !matches!(
            scene.source,
            SceneSourceV1::ImportedManimServerSnapshot { .. }
        ) || !scene.animation_channels.is_empty()
            || !studio_authoring_size_is_positive(frame)
            || !studio_authoring_size_is_positive(viewport)
            || frame.width != scene.camera.view.frame_width
            || frame.height != scene.camera.view.frame_height
            || programs.is_empty()
        {
            return Err(ApplyStudioMotionEditError::Unsupported);
        }

        let plan = plan_studio_motion_programs(scene.duration, &programs)
            .map_err(|_| ApplyStudioMotionEditError::Unsupported)?;
        let mut planned_motions = Vec::with_capacity(plan.motions.len());
        let mut parallel_runtime_targets: Vec<(String, f64, String)> = Vec::new();
        let provenance_id = format!("studio-motion:{next_revision}");
        for motion in &plan.motions {
            let runtime_entity_ids = resolve_studio_motion_targets(
                &motion.target_entity_ids,
                &studio_entities,
                &source_runtime_bindings,
            )
            .ok_or(ApplyStudioMotionEditError::Unsupported)?;
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
                        return Err(ApplyStudioMotionEditError::Unsupported);
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
            )?;
            planned_motions.push(PlannedSceneMotion {
                control_offset,
                delta,
                easing: motion.easing,
                interval: motion.interval.clone(),
                target_entity_ids: runtime_entity_ids,
            });
        }

        self.commit_scene_motions(
            &planned_motions,
            &plan.timeline_insertions,
            &ProvenanceRecordV1 {
                evidence: plan
                    .motions
                    .iter()
                    .map(|motion| format!("authorized operation {}", motion.operation_id))
                    .collect(),
                id: provenance_id,
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
            next_revision,
        )
    }

    /// Atomically adds one quadratic world-space motion to one or more root entities.
    #[cfg(test)]
    fn create_scene_motion(
        &mut self,
        command: CreateSceneMotionCommand,
    ) -> Result<SceneIrBundleV1, ApplyStudioMotionEditError> {
        let scene = self.scene();
        validate_create_scene_motion_command(scene, &command)?;
        let duration = command.interval.end - command.interval.start;
        self.commit_scene_motions(
            &[PlannedSceneMotion {
                control_offset: command.control_offset,
                delta: command.delta,
                easing: command.easing,
                interval: command.interval.clone(),
                target_entity_ids: command.target_entity_ids,
            }],
            &[SceneTimelineInsertion {
                at: command.interval.start,
                duration,
            }],
            &command.provenance,
            command.next_revision,
        )
    }

    fn commit_scene_motions(
        &mut self,
        motions: &[PlannedSceneMotion],
        timeline_insertions: &[SceneTimelineInsertion],
        provenance: &ProvenanceRecordV1,
        next_revision: String,
    ) -> Result<SceneIrBundleV1, ApplyStudioMotionEditError> {
        let scene = self.scene();
        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: scene.clone(),
        };
        for insertion in timeline_insertions {
            insert_scene_time(&mut candidate.scene, insertion);
        }
        candidate.scene.provenance.push(provenance.clone());
        append_planned_scene_motions(&mut candidate.scene, motions, &provenance.id)?;
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: next_revision,
        };

        let result = candidate.clone();
        self.replace_snapshot(candidate)?;
        Ok(result)
    }

    /// Atomically rotates one root entity about a world-space pivot.
    ///
    /// The command is deliberately independent of source profiles, viewport coordinates, and
    /// Manim bindings. Integration code must authorize and lower those concerns before calling
    /// this method.
    ///
    /// # Errors
    ///
    /// Returns a command or whole-bundle validation error. Every failure preserves the installed
    /// Scene and retained index.
    fn rotate_scene_entity(
        &mut self,
        command: RotateSceneEntityCommand,
    ) -> Result<SceneIrBundleV1, RotateSceneEntityError> {
        if self.scene().source.revision_hash() != command.expected_base_revision {
            return Err(RotateSceneEntityError::StaleBaseRevision);
        }
        if command.next_revision == command.expected_base_revision {
            return Err(RotateSceneEntityError::RevisionDidNotAdvance);
        }
        if !command.angle_radians.is_finite() || rotation_is_noop(command.angle_radians) {
            return Err(RotateSceneEntityError::InvalidAngle);
        }
        if !command.pivot.x.is_finite() || !command.pivot.y.is_finite() {
            return Err(RotateSceneEntityError::InvalidPivot);
        }
        if command.provenance.origin != ProvenanceOriginV1::StudioEditProgram {
            return Err(RotateSceneEntityError::InvalidProvenanceOrigin);
        }
        if self
            .scene()
            .provenance
            .iter()
            .any(|record| record.id == command.provenance.id)
        {
            return Err(RotateSceneEntityError::ProvenanceConflict(
                command.provenance.id,
            ));
        }

        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        if has_animated_transform(&candidate.scene, &command.entity_id) {
            return Err(RotateSceneEntityError::AnimatedTransformUnsupported(
                command.entity_id,
            ));
        }
        let target = candidate
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == command.entity_id)
            .ok_or_else(|| RotateSceneEntityError::TargetMissing(command.entity_id.clone()))?;
        if target.parent_id.is_some() {
            return Err(RotateSceneEntityError::TargetIsNotRoot(command.entity_id));
        }

        let cosine = command.angle_radians.cos();
        let sine = command.angle_radians.sin();
        let transform = &target.transform;
        target.transform = poietra_scene_ir::AffineTransformV1 {
            m11: cosine * transform.m11 - sine * transform.m21,
            m12: cosine * transform.m12 - sine * transform.m22,
            m21: sine * transform.m11 + cosine * transform.m21,
            m22: sine * transform.m12 + cosine * transform.m22,
            tx: command.pivot.x + cosine * (transform.tx - command.pivot.x)
                - sine * (transform.ty - command.pivot.y),
            ty: command.pivot.y
                + sine * (transform.tx - command.pivot.x)
                + cosine * (transform.ty - command.pivot.y),
        };
        target.provenance_id.clone_from(&command.provenance.id);
        candidate.scene.provenance.push(command.provenance);
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: command.next_revision,
        };

        let result = candidate.clone();
        self.replace_snapshot(candidate)?;
        Ok(result)
    }

    /// Applies the closed imported-root static edit subset.
    ///
    /// The caller serializes every Program operation, including unsupported ones. This method is
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
                    || !studio_program_anchor_is_closed(
                        &program.anchor_source,
                        program.anchor_captured_playhead,
                        program.anchor_resolved_seconds,
                        scene.duration,
                    )
                    || !static_root_transform_program_is_closed(program)
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
                    static_root_motion_program(program)
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
                plan_studio_motion_programs(scene.duration, &motion_programs)
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
                mutations: static_root_mutations,
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

    /// Atomically resolves and applies one world-space transform intent to one entity.
    ///
    /// Relative transforms use their explicit pivot. Baseline transforms first verify the
    /// installed static root geometry, derive its world center, and use that center as the scale
    /// pivot. Both intents then share one mutation and whole-bundle validation path.
    ///
    /// # Errors
    ///
    /// Returns a command or whole-bundle validation error. Every failure preserves the installed
    /// Scene and retained index.
    #[allow(
        clippy::float_cmp,
        reason = "exact identity defines whether the optional scale is a valid command"
    )]
    fn transform_scene_entity(
        &mut self,
        command: TransformSceneEntityCommand,
    ) -> Result<SceneIrBundleV1, TransformSceneEntityError> {
        let TransformSceneEntityCommand {
            entity_id,
            expected_base_revision,
            intent,
            next_revision,
            provenance,
        } = command;
        if self.scene().source.revision_hash() != expected_base_revision {
            return Err(TransformSceneEntityError::StaleBaseRevision);
        }
        if next_revision == expected_base_revision {
            return Err(TransformSceneEntityError::RevisionDidNotAdvance);
        }
        if provenance.origin != ProvenanceOriginV1::StudioEditProgram {
            return Err(TransformSceneEntityError::InvalidProvenanceOrigin);
        }
        if self
            .scene()
            .provenance
            .iter()
            .any(|record| record.id == provenance.id)
        {
            return Err(TransformSceneEntityError::ProvenanceConflict(provenance.id));
        }

        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        if has_animated_transform(&candidate.scene, &entity_id) {
            return Err(TransformSceneEntityError::AnimatedTransformUnsupported(
                entity_id,
            ));
        }
        let target_index = candidate
            .scene
            .entities
            .iter()
            .position(|entity| entity.id == entity_id)
            .ok_or_else(|| TransformSceneEntityError::TargetMissing(entity_id.clone()))?;

        let (delta, scale) =
            resolve_transform_intent(&candidate.scene.entities[target_index], intent)?;

        let target = &candidate.scene.entities[target_index];
        let mut parent_id = target.parent_id.as_deref();
        while let Some(id) = parent_id {
            let Some(parent) = candidate
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == id)
            else {
                return Err(TransformSceneEntityError::TransformedAncestorUnsupported(
                    id.to_owned(),
                ));
            };
            if parent.transform != poietra_scene_ir::AffineTransformV1::identity()
                || has_animated_transform(&candidate.scene, id)
            {
                return Err(TransformSceneEntityError::TransformedAncestorUnsupported(
                    id.to_owned(),
                ));
            }
            parent_id = parent.parent_id.as_deref();
        }
        let target = &mut candidate.scene.entities[target_index];
        if let Some(scale) = &scale {
            apply_world_axis_scale(
                &mut target.transform,
                scale.x_factor,
                scale.y_factor,
                &scale.pivot,
            );
        }
        apply_world_translation(&mut target.transform, &delta);
        target.provenance_id.clone_from(&provenance.id);
        candidate.scene.provenance.push(provenance);
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: next_revision,
        };

        let result = candidate.clone();
        self.replace_snapshot(candidate)?;
        Ok(result)
    }

    /// Atomically applies a root transform from one exact Scene time onward.
    ///
    /// The target's static transform and every existing animation channel remain unchanged. A
    /// new affine channel uses the static transform before `at` and the transformed value from
    /// `at` onward. Uniform scale is applied about its world-space pivot before translation.
    ///
    /// # Errors
    ///
    /// Returns a command or whole-bundle validation error. Every failure preserves the installed
    /// Scene and retained index.
    fn transform_scene_entity_at_time(
        &mut self,
        command: TransformSceneEntityAtTimeCommand,
    ) -> Result<SceneIrBundleV1, TransformSceneEntityError> {
        validate_timed_transform_command(self.scene(), &command)?;

        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        let target = candidate
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == command.entity_id)
            .ok_or_else(|| TransformSceneEntityError::TargetMissing(command.entity_id.clone()))?;
        if target.parent_id.is_some() {
            return Err(TransformSceneEntityError::TargetIsNotRoot(
                command.entity_id,
            ));
        }
        if !target
            .lifetimes
            .iter()
            .any(|lifetime| command.at >= lifetime.start && command.at < lifetime.end)
        {
            return Err(TransformSceneEntityError::TargetInactive(command.entity_id));
        }
        if has_animated_transform(&candidate.scene, &command.entity_id) {
            return Err(TransformSceneEntityError::AnimatedTransformUnsupported(
                command.entity_id,
            ));
        }

        let mut transformed = target.transform.clone();
        if let Some(scale) = &command.scale {
            apply_world_axis_scale(
                &mut transformed,
                scale.x_factor,
                scale.y_factor,
                &scale.pivot,
            );
        }
        apply_world_translation(&mut transformed, &command.delta);
        let channel_id = unused_channel_id(&candidate.scene, "studio-transform-at-time");
        candidate
            .scene
            .animation_channels
            .push(AnimationChannelV1::AffineTransform {
                entity_id: command.entity_id,
                id: channel_id,
                keyframes: vec![
                    KeyframeV1 {
                        at: command.at,
                        easing_to_next: Some(EasingV1::Linear {}),
                        value: transformed.clone(),
                    },
                    KeyframeV1 {
                        at: candidate.scene.duration,
                        easing_to_next: None,
                        value: transformed,
                    },
                ],
                provenance_id: command.provenance.id.clone(),
            });
        let mut capabilities = candidate
            .scene
            .required_capabilities
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        capabilities.insert(SceneCapabilityV1::AffineTransformAnimation);
        candidate.scene.required_capabilities = capabilities.into_iter().collect();
        candidate.scene.provenance.push(command.provenance);
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: command.next_revision,
        };

        let result = candidate.clone();
        self.replace_snapshot(candidate)?;
        Ok(result)
    }

    /// Atomically sets every static vector-paint alpha in one root subtree.
    ///
    /// # Errors
    ///
    /// Returns a command or whole-bundle validation error. Every failure preserves the installed
    /// Scene and retained index.
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "the atomic subtree command keeps validation and candidate mutation together; an exact stored alpha match defines its no-op"
    )]
    fn set_subtree_vector_paint_alpha(
        &mut self,
        command: SetSubtreeVectorPaintAlphaCommand,
    ) -> Result<SceneIrBundleV1, SetSubtreeVectorPaintAlphaError> {
        if self.scene().source.revision_hash() != command.expected_base_revision {
            return Err(SetSubtreeVectorPaintAlphaError::StaleBaseRevision);
        }
        if command.next_revision == command.expected_base_revision {
            return Err(SetSubtreeVectorPaintAlphaError::RevisionDidNotAdvance);
        }
        if !command.alpha.is_finite() || !(0.0..=1.0).contains(&command.alpha) {
            return Err(SetSubtreeVectorPaintAlphaError::InvalidAlpha);
        }
        if command.provenance.origin != ProvenanceOriginV1::StudioEditProgram {
            return Err(SetSubtreeVectorPaintAlphaError::InvalidProvenanceOrigin);
        }
        if self
            .scene()
            .provenance
            .iter()
            .any(|record| record.id == command.provenance.id)
        {
            return Err(SetSubtreeVectorPaintAlphaError::ProvenanceConflict(
                command.provenance.id,
            ));
        }

        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        let entity_indexes = candidate
            .scene
            .entities
            .iter()
            .enumerate()
            .map(|(index, entity)| (entity.id.as_str(), index))
            .collect::<std::collections::HashMap<_, _>>();
        let root_index = *entity_indexes
            .get(command.root_entity_id.as_str())
            .ok_or_else(|| {
                SetSubtreeVectorPaintAlphaError::TargetMissing(command.root_entity_id.clone())
            })?;
        if candidate.scene.entities[root_index].parent_id.is_some() {
            return Err(SetSubtreeVectorPaintAlphaError::TargetIsNotRoot(
                command.root_entity_id,
            ));
        }

        let mut children = vec![Vec::new(); candidate.scene.entities.len()];
        for (entity_index, entity) in candidate.scene.entities.iter().enumerate() {
            if let Some(parent_id) = entity.parent_id.as_deref() {
                let Some(&parent_index) = entity_indexes.get(parent_id) else {
                    return Err(SetSubtreeVectorPaintAlphaError::UnsupportedSubtreeEntity(
                        entity.id.clone(),
                    ));
                };
                children[parent_index].push(entity_index);
            }
        }
        let mut subtree = vec![false; candidate.scene.entities.len()];
        let mut pending = vec![root_index];
        while let Some(entity_index) = pending.pop() {
            if subtree[entity_index] {
                continue;
            }
            subtree[entity_index] = true;
            pending.extend(children[entity_index].iter().copied());
        }

        for channel in &candidate.scene.animation_channels {
            let (AnimationChannelV1::Opacity { entity_id, .. }
            | AnimationChannelV1::VectorAppearance { entity_id, .. }) = channel
            else {
                continue;
            };
            let Some(&entity_index) = entity_indexes.get(entity_id.as_str()) else {
                return Err(SetSubtreeVectorPaintAlphaError::UnsupportedSubtreeEntity(
                    entity_id.clone(),
                ));
            };
            if subtree[entity_index] {
                return Err(SetSubtreeVectorPaintAlphaError::AnimatedPaintUnsupported(
                    entity_id.clone(),
                ));
            }
        }
        drop(entity_indexes);

        let mut changed_entities = 0usize;
        for (entity_index, entity) in candidate.scene.entities.iter_mut().enumerate() {
            if !subtree[entity_index] {
                continue;
            }
            match (&entity.geometry, &mut entity.appearance) {
                (SceneGeometryV1::Group {}, SceneAppearanceV1::Group { .. }) => {}
                (
                    SceneGeometryV1::Circle { .. }
                    | SceneGeometryV1::Rectangle { .. }
                    | SceneGeometryV1::Line { .. }
                    | SceneGeometryV1::CubicPath { .. },
                    SceneAppearanceV1::Vector { fill, stroke, .. },
                ) if fill.is_some() || stroke.is_some() => {
                    let fill_changed = fill
                        .as_ref()
                        .is_some_and(|paint| paint.color.alpha != command.alpha);
                    let stroke_changed = stroke
                        .as_ref()
                        .is_some_and(|paint| paint.color.alpha != command.alpha);
                    if let Some(fill) = fill {
                        fill.color.alpha = command.alpha;
                    }
                    if let Some(stroke) = stroke {
                        stroke.color.alpha = command.alpha;
                    }
                    if fill_changed || stroke_changed {
                        changed_entities += 1;
                        entity.provenance_id.clone_from(&command.provenance.id);
                    }
                }
                _ => {
                    return Err(SetSubtreeVectorPaintAlphaError::UnsupportedSubtreeEntity(
                        entity.id.clone(),
                    ));
                }
            }
        }
        if changed_entities == 0 {
            return Err(SetSubtreeVectorPaintAlphaError::NoPaintChanged);
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
    use std::{fs, path::PathBuf};

    use poietra_scene_ir::{
        RuntimeTraceVersionV1, SceneIrBundleV1, SceneSourceV1, SnapshotProfileVersionV1,
        parse_scene_ir_bundle_json_v1,
    };

    use super::*;

    const BASE_REVISION: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const NEXT_REVISION: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    fn fixture_bundle(name: &str) -> SceneIrBundleV1 {
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

    fn imported_bundle() -> SceneIrBundleV1 {
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

    fn static_imported_bundle() -> SceneIrBundleV1 {
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

    fn math_tex_fixture_path(name: &str) -> CubicPathV1 {
        let SceneGeometryV1::CubicPath { path } =
            fixture_bundle(name).scene.entities.remove(0).geometry
        else {
            panic!("MathTex fixture must contain cubic-path geometry");
        };
        path
    }

    fn static_imported_math_tex_bundle() -> SceneIrBundleV1 {
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

    fn math_tex_transform_program(
        transaction_id: &str,
        anchor: f64,
        operations: Vec<StudioMathTexTransformOperation>,
    ) -> StudioMathTexTransformProgram {
        let operation_ids = operations
            .iter()
            .map(|operation| operation.id().to_owned())
            .collect::<Vec<_>>();
        let schedule_edge_count = operations
            .iter()
            .map(|operation| operation.depends_on().len())
            .sum::<usize>()
            + operations.len().saturating_sub(1);
        StudioMathTexTransformProgram {
            anchor_captured_playhead: anchor,
            anchor_resolved_seconds: anchor,
            anchor_source: StudioProgramAnchorSource::Playhead {
                reference_seconds: Some(anchor),
            },
            intent_count: operations.len(),
            lowering_supported: true,
            operations,
            origin: StudioAuthoringOrigin::RemoteModel,
            requested_execution: StudioProgramExecution::Sequence,
            schedule_edge_count,
            schedule_mode: StudioProgramScheduleMode::Sequence,
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
            programs: vec![math_tex_transform_program(
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
            programs: vec![StaticRootTransformProgram {
                anchor_captured_playhead: 0.0,
                anchor_resolved_seconds: 0.0,
                anchor_source: StudioProgramAnchorSource::Playhead {
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
                requested_execution: StudioProgramExecution::Parallel,
                schedule_edge_count: 0,
                schedule_mode: StudioProgramScheduleMode::Parallel,
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

    fn static_root_position_command() -> ApplyStaticRootTransformEditCommand {
        ApplyStaticRootTransformEditCommand {
            expected_base_revision: BASE_REVISION.to_owned(),
            frame: StaticRootTransformSize {
                height: 9.0,
                width: 16.0,
            },
            math_tex_outlines: vec![],
            next_revision: NEXT_REVISION.to_owned(),
            programs: vec![StaticRootTransformProgram {
                anchor_captured_playhead: 0.0,
                anchor_resolved_seconds: 0.0,
                anchor_source: StudioProgramAnchorSource::Playhead {
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
                requested_execution: StudioProgramExecution::Parallel,
                schedule_edge_count: 0,
                schedule_mode: StudioProgramScheduleMode::Parallel,
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

    fn static_root_motion_program(target_entity_ids: Vec<String>) -> StaticRootTransformProgram {
        StaticRootTransformProgram {
            anchor_captured_playhead: 0.5,
            anchor_resolved_seconds: 0.5,
            anchor_source: StudioProgramAnchorSource::Playhead {
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
            requested_execution: StudioProgramExecution::Sequence,
            schedule_edge_count: 0,
            schedule_mode: StudioProgramScheduleMode::Sequence,
            schedule_order: vec!["move-imported-root".to_owned()],
            transaction_id: "move-imported-root".to_owned(),
        }
    }

    fn static_persistent_remove_program(
        targets: &[(&str, &str)],
        start: f64,
        end: f64,
    ) -> StaticRootTransformProgram {
        StaticRootTransformProgram {
            anchor_captured_playhead: start,
            anchor_resolved_seconds: start,
            anchor_source: StudioProgramAnchorSource::Playhead {
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
            requested_execution: StudioProgramExecution::Parallel,
            schedule_edge_count: 0,
            schedule_mode: StudioProgramScheduleMode::Parallel,
            schedule_order: targets
                .iter()
                .map(|(operation_id, _)| (*operation_id).to_owned())
                .collect(),
            transaction_id: "persistent-remove".to_owned(),
        }
    }

    fn studio_persistent_remove_program(
        entity_id: &str,
        start: f64,
        end: f64,
    ) -> StudioCreationProgram {
        StudioCreationProgram {
            anchor_captured_playhead: start,
            anchor_resolved_seconds: start,
            anchor_source: StudioProgramAnchorSource::Playhead {
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
            requested_execution: StudioProgramExecution::Parallel,
            schedule_edge_count: 0,
            schedule_mode: StudioProgramScheduleMode::Parallel,
            schedule_order: vec!["remove-created".to_owned()],
            transaction_id: "remove-created".to_owned(),
        }
    }

    fn command() -> RotateSceneEntityCommand {
        RotateSceneEntityCommand {
            angle_radians: std::f64::consts::FRAC_PI_2,
            entity_id: "later".to_owned(),
            expected_base_revision: BASE_REVISION.to_owned(),
            next_revision: NEXT_REVISION.to_owned(),
            pivot: PointV1 { x: 1.0, y: -0.5 },
            provenance: ProvenanceRecordV1 {
                evidence: vec!["authorized Studio rotation".to_owned()],
                id: "studio-rotation".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
        }
    }

    fn motion_command(bundle: &SceneIrBundleV1) -> CreateSceneMotionCommand {
        CreateSceneMotionCommand {
            control_offset: PointV1 { x: 0.0, y: 4.0 },
            delta: PointV1 { x: 6.0, y: 2.0 },
            easing: StudioMotionEasing::Smooth,
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            interval: IntervalV1 {
                end: 1.5,
                start: 0.5,
            },
            next_revision: NEXT_REVISION.to_owned(),
            provenance: ProvenanceRecordV1 {
                evidence: vec!["authorized Studio motion".to_owned()],
                id: "studio-motion-authoring".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
            target_entity_ids: vec!["later".to_owned(), "stroke".to_owned()],
        }
    }

    fn studio_motion_edit_command(bundle: &SceneIrBundleV1) -> ApplyStudioMotionEditCommand {
        ApplyStudioMotionEditCommand {
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            frame: StudioAuthoringSize {
                height: 9.0,
                width: 16.0,
            },
            next_revision: NEXT_REVISION.to_owned(),
            programs: vec![StudioMotionProgram {
                anchor_captured_playhead: 0.5,
                anchor_resolved_seconds: 0.5,
                anchor_source: StudioProgramAnchorSource::Playhead {
                    reference_seconds: Some(0.5),
                },
                intent_count: 1,
                lowering_supported: true,
                operations: vec![StudioMotionOperation::CreateMotion {
                    control_offset: PointV1 { x: 0.0, y: -160.0 },
                    delta: PointV1 { x: 240.0, y: -80.0 },
                    depends_on: vec![],
                    easing: StudioMotionEasing::Smooth,
                    id: "create-motion".to_owned(),
                    interval: IntervalV1 {
                        end: 1.5,
                        start: 0.5,
                    },
                    origin: StudioAuthoringOrigin::DirectManipulation,
                    target_entity_ids: vec!["source:later".to_owned(), "source:stroke".to_owned()],
                }],
                origin: StudioAuthoringOrigin::DirectManipulation,
                requested_execution: StudioProgramExecution::Sequence,
                schedule_edge_count: 0,
                schedule_mode: StudioProgramScheduleMode::Sequence,
                schedule_order: vec!["create-motion".to_owned()],
                transaction_id: "create-motion".to_owned(),
            }],
            source_runtime_bindings: vec![
                StudioMotionSourceBinding {
                    runtime_entity_id: "later".to_owned(),
                    source_identity_key: "later-source".to_owned(),
                    source_name: "later-source".to_owned(),
                },
                StudioMotionSourceBinding {
                    runtime_entity_id: "stroke".to_owned(),
                    source_identity_key: "stroke-source".to_owned(),
                    source_name: "stroke-source".to_owned(),
                },
            ],
            studio_entities: vec![
                StudioMotionEntityIdentity {
                    object_graph_key: "source:later".to_owned(),
                    provisional: false,
                    source_identity: Some("later-source".to_owned()),
                },
                StudioMotionEntityIdentity {
                    object_graph_key: "source:stroke".to_owned(),
                    provisional: false,
                    source_identity: Some("stroke-source".to_owned()),
                },
            ],
            viewport: StudioAuthoringSize {
                height: 360.0,
                width: 640.0,
            },
        }
    }

    fn two_motion_sequence_command(bundle: &SceneIrBundleV1) -> ApplyStudioMotionEditCommand {
        let mut command = studio_motion_edit_command(bundle);
        let program = &mut command.programs[0];
        let StudioMotionOperation::CreateMotion {
            interval,
            target_entity_ids,
            ..
        } = &mut program.operations[0]
        else {
            unreachable!();
        };
        interval.end = 1.0;
        *target_entity_ids = vec!["source:later".to_owned()];
        program
            .operations
            .push(StudioMotionOperation::CreateMotion {
                control_offset: PointV1 { x: 80.0, y: 0.0 },
                delta: PointV1 { x: 0.0, y: -120.0 },
                depends_on: vec!["create-motion".to_owned()],
                easing: StudioMotionEasing::Linear,
                id: "create-motion-second".to_owned(),
                interval: IntervalV1 {
                    end: 1.75,
                    start: 1.25,
                },
                origin: StudioAuthoringOrigin::DirectManipulation,
                target_entity_ids: vec!["source:later".to_owned()],
            });
        program.intent_count = 2;
        program.schedule_edge_count = 1;
        program.schedule_order = vec![
            "create-motion".to_owned(),
            "create-motion-second".to_owned(),
        ];
        command
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the test builder names each independent normalized motion fact"
    )]
    fn studio_motion_program(
        template: &StudioMotionProgram,
        transaction_id: &str,
        anchor: f64,
        end: f64,
        target_entity_ids: Vec<String>,
        delta: PointV1,
        control_offset: PointV1,
        easing: StudioMotionEasing,
    ) -> StudioMotionProgram {
        let operation_id = format!("{transaction_id}-motion");
        StudioMotionProgram {
            anchor_captured_playhead: anchor,
            anchor_resolved_seconds: anchor,
            anchor_source: StudioProgramAnchorSource::Playhead {
                reference_seconds: Some(anchor),
            },
            operations: vec![StudioMotionOperation::CreateMotion {
                control_offset,
                delta,
                depends_on: vec![],
                easing,
                id: operation_id.clone(),
                interval: IntervalV1 { end, start: anchor },
                origin: template.origin,
                target_entity_ids,
            }],
            schedule_order: vec![operation_id],
            transaction_id: transaction_id.to_owned(),
            ..template.clone()
        }
    }

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
                    from: Some(0.25),
                    id,
                    interval,
                    origin,
                    relative_delta: Some(0.5),
                    to: Some(0.75),
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
            programs: vec![StudioBoundEntityProgram {
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

    fn real_line_joints_bundle() -> SceneIrBundleV1 {
        let mut bundle = fixture_bundle("real-line-joints-v10.json");
        let root = bundle
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.parent_id.is_none())
            .unwrap();
        root.transform = poietra_scene_ir::AffineTransformV1 {
            m11: 1.25,
            m12: 0.5,
            m21: -0.25,
            m22: 0.75,
            tx: 3.0,
            ty: -2.0,
        };
        bundle
    }

    fn transform_command_for(
        bundle: &SceneIrBundleV1,
        entity_id: &str,
    ) -> TransformSceneEntityCommand {
        TransformSceneEntityCommand {
            entity_id: entity_id.to_owned(),
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            intent: TransformSceneEntityIntent::Relative {
                delta: PointV1 { x: 2.0, y: -1.0 },
                scale: Some(ScaleAboutPivot {
                    pivot: PointV1 { x: 1.0, y: -0.5 },
                    x_factor: 1.5,
                    y_factor: 1.5,
                }),
            },
            next_revision: NEXT_REVISION.to_owned(),
            provenance: ProvenanceRecordV1 {
                evidence: vec!["authorized Studio atomic transform".to_owned()],
                id: "studio-atomic-transform".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
        }
    }

    fn baseline_transform_command_for(
        bundle: &SceneIrBundleV1,
        entity_id: &str,
    ) -> TransformSceneEntityCommand {
        TransformSceneEntityCommand {
            entity_id: entity_id.to_owned(),
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            intent: TransformSceneEntityIntent::FromBaseline {
                expected_baseline: TransformSceneEntityExpectedBaseline::WorldSize {
                    height: 1.0,
                    width: 1.0,
                    world_center: PointV1 { x: 4.0, y: -2.0 },
                },
                scale: Some(SceneEntityAxisFactors {
                    x_factor: 1.5,
                    y_factor: 1.5,
                }),
                target_center: Some(PointV1 { x: 6.0, y: -3.0 }),
            },
            next_revision: NEXT_REVISION.to_owned(),
            provenance: ProvenanceRecordV1 {
                evidence: vec!["verified Studio transform baseline".to_owned()],
                id: "studio-baseline-transform".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
        }
    }

    fn current_uniform_transform_command_for(
        bundle: &SceneIrBundleV1,
        entity_id: &str,
    ) -> TransformSceneEntityCommand {
        let mut command = baseline_transform_command_for(bundle, entity_id);
        let TransformSceneEntityIntent::FromBaseline {
            expected_baseline, ..
        } = &mut command.intent
        else {
            unreachable!();
        };
        *expected_baseline = TransformSceneEntityExpectedBaseline::CurrentUniformAffine;
        command
    }

    fn timed_transform_command_for(
        bundle: &SceneIrBundleV1,
        entity_id: &str,
    ) -> TransformSceneEntityAtTimeCommand {
        TransformSceneEntityAtTimeCommand {
            at: 1.0,
            delta: PointV1 { x: 2.0, y: -1.0 },
            entity_id: entity_id.to_owned(),
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            next_revision: NEXT_REVISION.to_owned(),
            provenance: ProvenanceRecordV1 {
                evidence: vec!["authorized Studio endpoint transform".to_owned()],
                id: "studio-endpoint-transform".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
            scale: Some(ScaleAboutPivot {
                pivot: PointV1 { x: 1.0, y: -0.5 },
                x_factor: 1.5,
                y_factor: 1.5,
            }),
        }
    }

    fn create_command(bundle: &SceneIrBundleV1) -> CreateSceneEntitiesCommand {
        let SceneGeometryV1::CubicPath { path } =
            fixture_bundle("mathtex-nested-radical-fraction.json")
                .scene
                .entities
                .remove(0)
                .geometry
        else {
            panic!("MathTex fixture must contain cubic-path geometry");
        };
        CreateSceneEntitiesCommand {
            entities: vec![
                CreateSceneEntity {
                    fade_in: None,
                    geometry: CreateSceneEntityGeometry::Circle { radius: 0.75 },
                    id: "tx:create/entity:circle".to_owned(),
                    lifetime: IntervalV1 {
                        end: 2.5,
                        start: 0.5,
                    },
                    position: PointV1 { x: 2.0, y: -1.0 },
                    scale: 1.25,
                    instant_transform: None,
                },
                CreateSceneEntity {
                    fade_in: Some(CreateSceneEntityFadeIn { end: 0.9 }),
                    geometry: CreateSceneEntityGeometry::Rectangle {
                        height: 2.0,
                        width: 3.0,
                    },
                    id: "tx:create/entity:rectangle".to_owned(),
                    lifetime: IntervalV1 {
                        end: 2.5,
                        start: 0.5,
                    },
                    position: PointV1 { x: -2.0, y: 1.0 },
                    scale: 0.5,
                    instant_transform: Some(CreateSceneEntityInstantTransform {
                        at: 1.25,
                        position: PointV1 { x: -1.0, y: 0.5 },
                        scale_x: 0.75,
                        scale_y: 1.0,
                    }),
                },
                CreateSceneEntity {
                    fade_in: None,
                    geometry: CreateSceneEntityGeometry::MathTex { path },
                    id: "tx:create/entity:mathtex".to_owned(),
                    lifetime: IntervalV1 {
                        end: 2.5,
                        start: 0.5,
                    },
                    position: PointV1 { x: 0.0, y: 1.5 },
                    scale: 2.0,
                    instant_transform: None,
                },
            ],
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
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
                StudioCreationProgram {
                    anchor_captured_playhead: 0.5,
                    anchor_resolved_seconds: 0.5,
                    anchor_source: StudioProgramAnchorSource::Playhead {
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
                                    kind: StudioAuthoringEntityKind::Circle,
                                    lifetime_end: None,
                                    lifetime_start: 0.5,
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
                    requested_execution: StudioProgramExecution::Parallel,
                    schedule_edge_count: 4,
                    schedule_mode: StudioProgramScheduleMode::DependencyDag,
                    schedule_order: vec![
                        "create".to_owned(),
                        "position".to_owned(),
                        "fade".to_owned(),
                    ],
                    transaction_id: "create".to_owned(),
                },
                StudioCreationProgram {
                    anchor_captured_playhead: 0.85,
                    anchor_resolved_seconds: 0.85,
                    anchor_source: StudioProgramAnchorSource::Playhead {
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
                    requested_execution: StudioProgramExecution::Sequence,
                    schedule_edge_count: 0,
                    schedule_mode: StudioProgramScheduleMode::Sequence,
                    schedule_order: vec!["resize".to_owned()],
                    transaction_id: "resize".to_owned(),
                },
            ],
            viewport: StudioAuthoringSize {
                height: 360.0,
                width: 640.0,
            },
        }
    }

    fn studio_created_motion_program(target_entity_ids: Vec<String>) -> StudioCreationProgram {
        StudioCreationProgram {
            anchor_captured_playhead: 1.0,
            anchor_resolved_seconds: 1.0,
            anchor_source: StudioProgramAnchorSource::Playhead {
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
            requested_execution: StudioProgramExecution::Sequence,
            schedule_edge_count: 0,
            schedule_mode: StudioProgramScheduleMode::Sequence,
            schedule_order: vec!["move-created".to_owned()],
            transaction_id: "move-created".to_owned(),
        }
    }

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

    fn studio_timeline_wait_program(
        id: &str,
        source_seconds: f64,
        duration: f64,
    ) -> StudioTimelineProgram {
        StudioTimelineProgram {
            anchor_captured_playhead: source_seconds,
            anchor_resolved_seconds: source_seconds,
            anchor_source: StudioProgramAnchorSource::Absolute {
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
            requested_execution: StudioProgramExecution::Sequence,
            schedule_edge_count: 0,
            schedule_mode: StudioProgramScheduleMode::Sequence,
            schedule_order: vec![id.to_owned()],
            transaction_id: id.to_owned(),
        }
    }

    fn studio_timeline_trim_program(
        id: &str,
        source_seconds: f64,
        removed_duration: f64,
        target_duration: f64,
        wait_operation_ids: Vec<String>,
    ) -> StudioTimelineProgram {
        StudioTimelineProgram {
            anchor_captured_playhead: source_seconds,
            anchor_resolved_seconds: source_seconds,
            anchor_source: StudioProgramAnchorSource::Absolute {
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
            requested_execution: StudioProgramExecution::Sequence,
            schedule_edge_count: 0,
            schedule_mode: StudioProgramScheduleMode::Sequence,
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
                studio_timeline_wait_program("wait-1", source_seconds, 1.0),
                studio_timeline_trim_program(
                    "trim-1",
                    source_seconds,
                    0.5,
                    bundle.scene.duration + 0.5,
                    vec!["wait-1".to_owned()],
                ),
                studio_timeline_wait_program("wait-2", source_seconds, 1.0),
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

    fn rejected_transform(
        bundle: SceneIrBundleV1,
        command: TransformSceneEntityCommand,
    ) -> TransformSceneEntityError {
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let error = session.transform_scene_entity(command).unwrap_err();
        assert_eq!(session.scene(), &expected_scene);
        assert_eq!(session.assets(), &expected_assets);
        assert_eq!(session.retained_index_stats().build_count, 1);
        error
    }

    fn rejected_timed_transform(
        bundle: SceneIrBundleV1,
        command: TransformSceneEntityAtTimeCommand,
    ) -> TransformSceneEntityError {
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let error = session.transform_scene_entity_at_time(command).unwrap_err();
        assert_eq!(session.scene(), &expected_scene);
        assert_eq!(session.assets(), &expected_assets);
        assert_eq!(session.retained_index_stats().build_count, 1);
        error
    }

    fn rejected_motion(
        bundle: SceneIrBundleV1,
        command: CreateSceneMotionCommand,
    ) -> ApplyStudioMotionEditError {
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let error = session.create_scene_motion(command).unwrap_err();
        assert_eq!(session.scene(), &expected_scene);
        assert_eq!(session.assets(), &expected_assets);
        assert_eq!(session.retained_index_stats().build_count, 1);
        error
    }

    fn rejected_studio_motion(
        bundle: SceneIrBundleV1,
        command: ApplyStudioMotionEditCommand,
    ) -> ApplyStudioMotionEditError {
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let error = session.apply_studio_motion_edit(command).unwrap_err();
        assert_eq!(session.scene(), &expected_scene);
        assert_eq!(session.assets(), &expected_assets);
        assert_eq!(session.retained_index_stats().build_count, 1);
        error
    }

    fn paint_alpha_command_for(
        bundle: &SceneIrBundleV1,
        root_entity_id: &str,
    ) -> SetSubtreeVectorPaintAlphaCommand {
        let expected_base_revision = bundle.scene.source.revision_hash().to_owned();
        let next_revision = if expected_base_revision == NEXT_REVISION {
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned()
        } else {
            NEXT_REVISION.to_owned()
        };
        SetSubtreeVectorPaintAlphaCommand {
            alpha: 0.25,
            expected_base_revision,
            next_revision,
            provenance: ProvenanceRecordV1 {
                evidence: vec!["authorized Studio subtree paint alpha".to_owned()],
                id: "studio-subtree-paint-alpha".to_owned(),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
            root_entity_id: root_entity_id.to_owned(),
        }
    }

    fn rejected_paint_alpha(
        bundle: SceneIrBundleV1,
        command: SetSubtreeVectorPaintAlphaCommand,
    ) -> SetSubtreeVectorPaintAlphaError {
        let expected_scene = bundle.scene.clone();
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();
        let error = session.set_subtree_vector_paint_alpha(command).unwrap_err();
        assert_eq!(session.scene(), &expected_scene);
        assert_eq!(session.assets(), &expected_assets);
        assert_eq!(session.retained_index_stats().build_count, 1);
        error
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
            let mut session = EngineSessionV1::new(bundle).unwrap();

            let result = session.apply_studio_bound_entity_edit(command).unwrap();

            let provenance_id = format!(
                "studio-bound-endpoint-{}-{}:{NEXT_REVISION}",
                phase.as_str(),
                edit.provenance_kind()
            );
            assert_eq!(result.scene.source.revision_hash(), NEXT_REVISION);
            assert!(
                result
                    .scene
                    .provenance
                    .iter()
                    .any(|record| record.id == provenance_id)
            );
            assert_bound_entity_effect(&result, phase, edit);
            assert_eq!(session.retained_index_stats().build_count, 2);
        }
    }

    #[test]
    fn rejects_unsupported_or_ambiguous_bound_entity_edits_atomically() {
        for case in 0..6 {
            let mut bundle = bound_entity_bundle();
            let edit = if case == 0 {
                BoundEntityTestEdit::Unsupported
            } else {
                BoundEntityTestEdit::Move
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
            command
                .programs
                .push(static_root_motion_program(vec!["source:circle".to_owned()]));
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
        command.programs.push(static_root_motion_program(vec![
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
            command
                .programs
                .push(static_root_motion_program(vec!["source:circle".to_owned()]));
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
        later_static.anchor_source = StudioProgramAnchorSource::Playhead {
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
            static_persistent_remove_program(&[("remove-root", "source:circle")], 0.0, 0.0);

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
        command.programs[0].requested_execution = StudioProgramExecution::Sequence;
        command.programs[0].schedule_edge_count = 1;
        command.programs[0].schedule_mode = StudioProgramScheduleMode::Sequence;
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
        assert_eq!(
            serde_json::to_value(&result).unwrap()["staticRootProjection"],
            serde_json::json!({
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
        command.programs = vec![static_persistent_remove_program(
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
        command.programs.push(static_persistent_remove_program(
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
    fn zero_duration_persistent_remove_drops_every_future_lifetime() {
        let mut scene = static_imported_bundle().scene;
        let target = scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == "later")
            .unwrap();
        target.lifetimes = vec![
            IntervalV1 {
                start: 0.0,
                end: 0.5,
            },
            IntervalV1 {
                start: 1.0,
                end: 1.5,
            },
            IntervalV1 {
                start: 1.75,
                end: 2.0,
            },
        ];

        let projection = apply_persistent_scene_removals(
            &mut scene,
            &[PersistentSceneRemoval {
                entity_id: "later".to_owned(),
                interval: IntervalV1 {
                    start: 1.2,
                    end: 1.2,
                },
                operation_id: "remove-later".to_owned(),
                studio_entity_id: "source:circle".to_owned(),
                transaction_id: "remove-later".to_owned(),
            }],
            "remove-provenance",
        )
        .unwrap();

        let target = scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();
        assert_eq!(
            target.lifetimes,
            vec![
                IntervalV1 {
                    start: 0.0,
                    end: 0.5,
                },
                IntervalV1 {
                    start: 1.0,
                    end: 1.2,
                },
            ]
        );
        assert!(scene.animation_channels.is_empty());
        assert_eq!(projection.removals[0].fade_interval, None);
        assert!((projection.removals[0].removed_at - 1.2).abs() < 1e-9);
    }

    #[test]
    fn persistent_remove_owns_a_complete_subtree_and_rejects_overlapping_targets_atomically() {
        let bundle = fixture_bundle("real-line-joints-v10.json");
        let root_id = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.is_none())
            .unwrap()
            .id
            .clone();
        let child_id = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.as_deref() == Some(root_id.as_str()))
            .unwrap()
            .id
            .clone();
        let removal = |entity_id: &str, operation_id: &str| PersistentSceneRemoval {
            entity_id: entity_id.to_owned(),
            interval: IntervalV1 {
                start: 0.5,
                end: 0.75,
            },
            operation_id: operation_id.to_owned(),
            studio_entity_id: entity_id.to_owned(),
            transaction_id: "remove-subtree".to_owned(),
        };
        let mut rejected = bundle.scene.clone();
        let expected = rejected.clone();

        let error = apply_persistent_scene_removals(
            &mut rejected,
            &[
                removal(&child_id, "remove-child"),
                removal(&root_id, "remove-root"),
            ],
            "remove-provenance",
        )
        .unwrap_err();

        assert!(matches!(
            error,
            ApplyStudioPersistentRemoveError::OverlappingTargets(_, _)
        ));
        assert_eq!(rejected, expected);

        let mut rejected_child = expected.clone();
        let error = apply_persistent_scene_removals(
            &mut rejected_child,
            &[removal(&child_id, "remove-child")],
            "remove-provenance",
        )
        .unwrap_err();
        assert!(matches!(
            error,
            ApplyStudioPersistentRemoveError::TargetIsNotRoot(id) if id == child_id
        ));
        assert_eq!(rejected_child, expected);

        let mut scene = bundle.scene;
        let projection = apply_persistent_scene_removals(
            &mut scene,
            &[removal(&root_id, "remove-root")],
            "remove-provenance",
        )
        .unwrap();
        assert_eq!(projection.removals[0].affected_scene_entity_ids.len(), 4);
        assert!(
            scene
                .entities
                .iter()
                .all(|entity| (entity.lifetimes.last().unwrap().end - 0.75).abs() < 1e-9)
        );
        assert_eq!(
            scene
                .animation_channels
                .iter()
                .filter(|channel| matches!(channel, AnimationChannelV1::Opacity { .. }))
                .count(),
            1
        );
        assert!(scene.animation_channels.iter().any(|channel| {
            matches!(
                channel,
                AnimationChannelV1::Opacity { entity_id, .. } if entity_id == &root_id
            )
        }));
    }

    #[test]
    fn persistent_remove_preserves_past_child_history_and_drops_future_only_children() {
        let mut bundle = fixture_bundle("real-line-joints-v10.json");
        let root_id = bundle.scene.entities[0].id.clone();
        let past_child_id = bundle.scene.entities[1].id.clone();
        let short_child_id = bundle.scene.entities[2].id.clone();
        let future_child_id = bundle.scene.entities[3].id.clone();
        bundle.scene.entities[1].lifetimes = vec![IntervalV1 {
            end: 0.25,
            start: 0.0,
        }];
        bundle.scene.entities[2].lifetimes = vec![IntervalV1 {
            end: 0.6,
            start: 0.0,
        }];
        bundle.scene.entities[3].lifetimes = vec![IntervalV1 {
            end: 1.0,
            start: 0.8,
        }];
        let provenance_id = bundle.scene.provenance[0].id.clone();
        let mut scene = bundle.scene;

        let projection = apply_persistent_scene_removals(
            &mut scene,
            &[PersistentSceneRemoval {
                entity_id: root_id.clone(),
                interval: IntervalV1 {
                    end: 0.75,
                    start: 0.5,
                },
                operation_id: "remove-root".to_owned(),
                studio_entity_id: "source:root".to_owned(),
                transaction_id: "remove-subtree".to_owned(),
            }],
            &provenance_id,
        )
        .unwrap();

        assert_eq!(
            projection.removals[0].affected_scene_entity_ids,
            vec![
                root_id.clone(),
                past_child_id.clone(),
                short_child_id.clone(),
                future_child_id.clone(),
            ]
        );
        assert_eq!(
            scene
                .entities
                .iter()
                .find(|entity| entity.id == past_child_id)
                .unwrap()
                .lifetimes,
            vec![IntervalV1 {
                end: 0.25,
                start: 0.0,
            }]
        );
        assert_eq!(
            scene
                .entities
                .iter()
                .find(|entity| entity.id == short_child_id)
                .unwrap()
                .lifetimes,
            vec![IntervalV1 {
                end: 0.6,
                start: 0.0,
            }]
        );
        assert!(
            scene
                .entities
                .iter()
                .all(|entity| entity.id != future_child_id)
        );
        EngineSessionV1::new(SceneIrBundleV1 {
            assets: bundle.assets,
            scene,
        })
        .unwrap();
    }

    #[test]
    fn rejects_open_static_programs_without_mutating_the_session() {
        let bundle = static_imported_bundle();
        let mut unsupported = static_root_position_command();
        unsupported.programs[0].operations[0].kind = StaticRootTransformOperationKind::Unsupported;
        let mut missing_dependency = static_root_position_command();
        missing_dependency.programs[0].operations[0].depends_on =
            vec!["missing-operation".to_owned()];
        let mut nonzero_transform = static_root_position_command();
        nonzero_transform.programs[0].anchor_captured_playhead = 0.5;
        nonzero_transform.programs[0].anchor_resolved_seconds = 0.5;
        nonzero_transform.programs[0].anchor_source = StudioProgramAnchorSource::Playhead {
            reference_seconds: Some(0.5),
        };
        nonzero_transform.programs[0].operations[0].interval = IntervalV1 {
            end: 0.5,
            start: 0.5,
        };
        let mut unknown_remove = static_root_position_command();
        unknown_remove.programs = vec![static_persistent_remove_program(
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
    fn rotates_an_imported_root_and_returns_the_installed_bundle() {
        let bundle = imported_bundle();
        let untouched = bundle.scene.entities[1..].to_vec();
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.rotate_scene_entity(command()).unwrap();
        let rotated = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();

        assert!(rotated.transform.m11.abs() < 1e-12);
        assert!((rotated.transform.m12 + 1.0).abs() < 1e-12);
        assert!((rotated.transform.m21 - 1.0).abs() < 1e-12);
        assert!(rotated.transform.m22.abs() < 1e-12);
        assert!((rotated.transform.tx - 2.5).abs() < 1e-12);
        assert!((rotated.transform.ty - 1.5).abs() < 1e-12);
        assert_eq!(rotated.provenance_id, "studio-rotation");
        assert_eq!(result.scene.entities[1..], untouched);
        assert_eq!(result.scene.provenance.last(), Some(&command().provenance));
        assert_eq!(
            result.scene.source,
            SceneSourceV1::StudioEditProgram {
                edit_program_version: ContractVersionV1,
                revision_hash: NEXT_REVISION.to_owned(),
            }
        );
        assert_eq!(session.scene(), &result.scene);
        assert_eq!(session.assets(), &result.assets);
        assert_eq!(session.retained_index_stats().build_count, 2);
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
            project_studio_creation_programs(bundle.scene.duration, &command.programs).unwrap();
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
            .push(studio_created_motion_program(vec![entity_id.to_owned()]));
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
        command.programs.push(studio_created_motion_program(vec![
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
    fn normalized_line_creation_composes_motion_then_scale_and_remove() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        let StudioCreationOperationKind::Create { entity } =
            &mut command.programs[0].operations[0].kind
        else {
            panic!("creation fixture must start with CreateEntity");
        };
        entity.kind = StudioAuthoringEntityKind::Line;
        entity.dimensions = StudioAuthoringDimensions::default();
        command.programs[1].operations[0].kind = StudioCreationOperationKind::UniformScale {
            control_present: false,
            from: Some(1.0),
            relative_factor: Some(1.5),
            to: Some(1.5),
        };
        let mut motion = studio_created_motion_program(vec![entity_id.to_owned()]);
        motion.anchor_captured_playhead = 0.75;
        motion.anchor_resolved_seconds = 0.75;
        motion.anchor_source = StudioProgramAnchorSource::Playhead {
            reference_seconds: Some(0.75),
        };
        motion.operations[0].interval = IntervalV1 {
            end: 1.75,
            start: 0.75,
        };
        command.programs.insert(1, motion);
        command
            .programs
            .push(studio_persistent_remove_program(entity_id, 1.8, 2.0));
        let projection =
            project_studio_creation_programs(bundle.scene.duration, &command.programs).unwrap();
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_creation_edit(command).unwrap();
        assert!(result.motion_projection.is_none());
        assert_eq!(result.creation_projection.as_ref(), Some(&projection));
        assert_eq!(projection.motions.len(), 1);
        assert!(projection.mutations.iter().any(|mutation| matches!(
            mutation.kind,
            StudioCreationProjectedMutationKind::UniformScale { from: 1.0, to: 1.5 }
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
            .push(studio_persistent_remove_program(entity_id, 1.4, 1.6));
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
        command.programs.push(StudioCreationProgram {
            anchor_captured_playhead: 0.5,
            anchor_resolved_seconds: 0.5,
            anchor_source: StudioProgramAnchorSource::Playhead {
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
                            kind: StudioAuthoringEntityKind::Rectangle,
                            lifetime_end: Some(1.0),
                            lifetime_start: 0.5,
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
            requested_execution: StudioProgramExecution::Parallel,
            schedule_edge_count: 4,
            schedule_mode: StudioProgramScheduleMode::DependencyDag,
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
    fn normalized_creation_rejects_hidden_and_malformed_programs_atomically() {
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
        reason = "these operations produce exact finite products"
    )]
    fn atomic_transform_supports_move_scale_and_their_composition() {
        let bundle = real_line_joints_bundle();
        let root_id = bundle.scene.entities[0].id.clone();
        for (delta, factors, expected) in [
            (
                PointV1 { x: 2.0, y: -1.0 },
                None,
                [1.25, 0.5, -0.25, 0.75, 5.0, -3.0],
            ),
            (
                PointV1 { x: 0.0, y: 0.0 },
                Some((1.5, 1.5)),
                [1.875, 0.75, -0.375, 1.125, 4.0, -2.75],
            ),
            (
                PointV1 { x: 0.0, y: 0.0 },
                Some((2.0, 0.5)),
                [2.5, 1.0, -0.125, 0.375, 5.0, -1.25],
            ),
            (
                PointV1 { x: 2.0, y: -1.0 },
                Some((1.5, 1.5)),
                [1.875, 0.75, -0.375, 1.125, 6.0, -3.75],
            ),
        ] {
            let mut command = transform_command_for(&bundle, &root_id);
            command.intent = TransformSceneEntityIntent::Relative {
                delta,
                scale: factors.map(|(x_factor, y_factor)| ScaleAboutPivot {
                    pivot: PointV1 { x: 1.0, y: -0.5 },
                    x_factor,
                    y_factor,
                }),
            };
            let mut session = EngineSessionV1::new(bundle.clone()).unwrap();

            let result = session.transform_scene_entity(command.clone()).unwrap();
            let transformed = result
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == root_id)
                .unwrap();

            assert_eq!(
                [
                    transformed.transform.m11,
                    transformed.transform.m12,
                    transformed.transform.m21,
                    transformed.transform.m22,
                    transformed.transform.tx,
                    transformed.transform.ty,
                ],
                expected
            );
            assert_eq!(transformed.provenance_id, command.provenance.id);
            assert_eq!(result.scene.provenance.last(), Some(&command.provenance));
            assert_eq!(session.scene(), &result.scene);
            assert_eq!(session.retained_index_stats().build_count, 2);
        }
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the command applies exact finite factors around its derived center"
    )]
    fn baseline_transform_verifies_world_size_and_uses_the_derived_center() {
        let bundle = imported_bundle();
        let target_id = "later";
        let command = baseline_transform_command_for(&bundle, target_id);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.transform_scene_entity(command.clone()).unwrap();
        let target = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == target_id)
            .unwrap();

        assert_eq!(target.transform.m11, 1.5);
        assert_eq!(target.transform.m22, 1.5);
        assert_eq!(target.transform.tx, 4.5);
        assert_eq!(target.transform.ty, -3.0);
        assert_eq!(target.provenance_id, command.provenance.id);
        assert_eq!(session.scene(), &result.scene);
        assert_eq!(session.retained_index_stats().build_count, 2);
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "scale-only authoring must retain the exact installed translation"
    )]
    fn scale_only_transform_uses_actual_center_when_expected_center_is_within_tolerance() {
        let mut bundle = imported_bundle();
        let target = bundle
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == "later")
            .unwrap();
        let SceneGeometryV1::Circle { center, .. } = &mut target.geometry else {
            panic!("fixture target must be a Circle");
        };
        *center = PointV1 { x: 0.0, y: 0.0 };
        let mut command = baseline_transform_command_for(&bundle, "later");
        let TransformSceneEntityIntent::FromBaseline {
            expected_baseline: TransformSceneEntityExpectedBaseline::WorldSize { world_center, .. },
            target_center,
            ..
        } = &mut command.intent
        else {
            unreachable!();
        };
        *target_center = None;
        *world_center = PointV1 {
            x: 3.0 + 1.0e-10,
            y: -2.0,
        };
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.transform_scene_entity(command).unwrap();
        let transformed = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();
        assert_eq!(transformed.transform.m11, 1.5);
        assert_eq!(transformed.transform.m22, 1.5);
        assert_eq!(transformed.transform.tx, 3.0);
        assert_eq!(transformed.transform.ty, -2.0);
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the current center produces one exact world-space translation"
    )]
    fn current_center_baseline_transforms_an_image_from_its_installed_geometry_center() {
        let mut bundle = fixture_bundle("png-alpha-edge-camera.json");
        bundle.scene.animation_channels.clear();
        bundle.scene.required_capabilities.retain(|capability| {
            !matches!(
                capability,
                SceneCapabilityV1::AffineTransformAnimation | SceneCapabilityV1::CameraAnimation
            )
        });
        let target_id = bundle.scene.entities[0].id.clone();
        let mut command = baseline_transform_command_for(&bundle, &target_id);
        let TransformSceneEntityIntent::FromBaseline {
            expected_baseline, ..
        } = &mut command.intent
        else {
            unreachable!();
        };
        *expected_baseline = TransformSceneEntityExpectedBaseline::CurrentCenter;
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.transform_scene_entity(command).unwrap();
        let transformed = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == target_id)
            .unwrap();

        assert!(matches!(
            transformed.geometry,
            SceneGeometryV1::Image { .. }
        ));
        assert_eq!(transformed.transform.m11, 3.0);
        assert_eq!(transformed.transform.m22, 3.0);
        assert_eq!(transformed.transform.tx, 6.0);
        assert_eq!(transformed.transform.ty, -3.0);
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the current baseline applies exact finite factors around its derived center"
    )]
    fn current_uniform_baseline_derives_the_transform_and_rejects_non_uniform_affines() {
        let bundle = imported_bundle();
        let command = current_uniform_transform_command_for(&bundle, "later");
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.transform_scene_entity(command).unwrap();
        let transformed = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();
        assert_eq!(transformed.transform.m11, 1.5);
        assert_eq!(transformed.transform.m22, 1.5);
        assert_eq!(transformed.transform.tx, 4.5);
        assert_eq!(transformed.transform.ty, -3.0);

        for [m11, m12, m21, m22] in [
            [0.0, -1.0, 1.0, 0.0],
            [1.0, 0.25, 0.0, 1.0],
            [1.0, 0.0, 0.0, 1.25],
            [-1.0, 0.0, 0.0, -1.0],
        ] {
            let mut bundle = imported_bundle();
            bundle
                .scene
                .entities
                .iter_mut()
                .find(|entity| entity.id == "later")
                .unwrap()
                .transform = AffineTransformV1 {
                m11,
                m12,
                m21,
                m22,
                tx: 3.0,
                ty: -2.0,
            };
            let expected = bundle.scene.clone();
            let command = current_uniform_transform_command_for(&bundle, "later");
            let mut session = EngineSessionV1::new(bundle).unwrap();
            assert!(matches!(
                session.transform_scene_entity(command),
                Err(TransformSceneEntityError::BaselineMismatch)
            ));
            assert_eq!(session.scene(), &expected);
        }
    }

    #[test]
    fn baseline_transform_supports_image_centers_and_world_sizes() {
        let mut rectangle = imported_bundle().scene.entities[0].clone();
        rectangle.geometry = SceneGeometryV1::Rectangle {
            center: PointV1 { x: 1.0, y: 2.0 },
            corner_radius: 0.0,
            height: 4.0,
            width: 6.0,
        };
        rectangle.transform = AffineTransformV1 {
            m11: 2.0,
            m12: 0.0,
            m21: 0.0,
            m22: 3.0,
            tx: -1.0,
            ty: 1.0,
        };
        let rectangle_bounds = scene_entity_local_bounds(&rectangle).unwrap();
        let rectangle_center = scene_entity_world_center(&rectangle, &rectangle_bounds);
        assert!(transform_baseline_matches(
            &rectangle,
            &TransformSceneEntityExpectedBaseline::WorldSize {
                height: 12.0,
                width: 12.0,
                world_center: rectangle_center.clone(),
            },
            &rectangle_bounds,
            &rectangle_center,
        ));

        let image_bundle = fixture_bundle("png-alpha-edge-camera.json");
        let image = &image_bundle.scene.entities[0];
        let image_bounds = scene_entity_local_bounds(image).unwrap();
        let image_center = scene_entity_world_center(image, &image_bounds);
        assert!(transform_baseline_matches(
            image,
            &TransformSceneEntityExpectedBaseline::CurrentCenter,
            &image_bounds,
            &image_center,
        ));

        assert!(!transform_is_uniform(1.5, 1.5 + 1.0e-10));

        let mut drifted = baseline_transform_command_for(&imported_bundle(), "later");
        let TransformSceneEntityIntent::FromBaseline {
            expected_baseline: TransformSceneEntityExpectedBaseline::WorldSize { world_center, .. },
            ..
        } = &mut drifted.intent
        else {
            unreachable!();
        };
        world_center.x += 0.01;
        let bundle = imported_bundle();
        let expected = bundle.scene.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();
        assert!(matches!(
            session.transform_scene_entity(drifted),
            Err(TransformSceneEntityError::BaselineMismatch)
        ));
        assert_eq!(session.scene(), &expected);
        assert_eq!(session.retained_index_stats().build_count, 1);
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
    fn studio_timeline_authority_rebases_same_anchor_wait_trim_wait_in_input_order() {
        let bundle = static_imported_bundle();
        let expected_duration = bundle.scene.duration + 1.5;
        let mut command = studio_timeline_command(&bundle);
        command.programs[1].anchor_captured_playhead = bundle.scene.duration + 1.0;
        let projection =
            project_studio_timeline_programs(bundle.scene.duration, &command.programs).unwrap();
        assert_eq!(
            projection.program_projections,
            vec![
                StudioTimelineProgramProjection {
                    operation_id: "wait-1".to_owned(),
                    transaction_id: "wait-1".to_owned(),
                    working_anchor: 0.5,
                    working_interval: IntervalV1 {
                        end: 1.5,
                        start: 0.5,
                    },
                },
                StudioTimelineProgramProjection {
                    operation_id: "trim-1".to_owned(),
                    transaction_id: "trim-1".to_owned(),
                    working_anchor: 1.5,
                    working_interval: IntervalV1 {
                        end: 1.5,
                        start: 1.5,
                    },
                },
                StudioTimelineProgramProjection {
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
    fn studio_timeline_authority_normalizes_decimal_trim_offset_before_the_next_program() {
        let bundle = static_imported_bundle();
        let base_duration = bundle.scene.duration;
        let source_anchor = 0.5;
        let command = ApplyStudioTimelineEditCommand {
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            next_revision: NEXT_REVISION.to_owned(),
            programs: vec![
                studio_timeline_wait_program("wait-a", source_anchor, 0.3),
                studio_timeline_wait_program("wait-b", source_anchor, 0.6),
                studio_timeline_trim_program(
                    "trim-all",
                    source_anchor,
                    0.9,
                    base_duration,
                    vec!["wait-b".to_owned(), "wait-a".to_owned()],
                ),
                studio_timeline_wait_program("wait-c", source_anchor, 0.2),
            ],
        };
        let projection =
            project_studio_timeline_programs(base_duration, &command.programs).unwrap();
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
            studio_timeline_wait_program("wait", 0.5, 1.0),
            studio_timeline_trim_program(
                "trim",
                0.5004,
                1.0,
                bundle.scene.duration,
                vec!["wait".to_owned()],
            ),
        ];
        assert!(matches!(
            project_studio_timeline_programs(bundle.scene.duration, &separated_waits),
            Err(ApplyStudioTimelineEditError::InvalidTrim)
        ));

        let over_trimmed = vec![
            studio_timeline_wait_program("wait", 0.5, 1.0),
            studio_timeline_trim_program(
                "trim",
                0.5,
                1.0004,
                bundle.scene.duration - 0.0004,
                vec!["wait".to_owned()],
            ),
        ];
        assert!(matches!(
            project_studio_timeline_programs(bundle.scene.duration, &over_trimmed),
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
        command.programs[0].anchor_source = StudioProgramAnchorSource::Absolute {
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
    fn atomic_transform_updates_one_authorized_nested_entity_only() {
        let bundle = fixture_bundle("real-line-joints-v10.json");
        let target = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.is_some())
            .unwrap()
            .clone();
        let mut command = transform_command_for(&bundle, &target.id);
        let TransformSceneEntityIntent::Relative { delta, scale } = &mut command.intent else {
            unreachable!();
        };
        *scale = None;
        let mut expected = target.clone();
        expected.transform.tx += delta.x;
        expected.transform.ty += delta.y;
        expected.provenance_id.clone_from(&command.provenance.id);
        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();

        let result = session.transform_scene_entity(command).unwrap();

        for (actual, before) in result.scene.entities.iter().zip(&bundle.scene.entities) {
            assert_eq!(
                actual,
                if actual.id == target.id {
                    &expected
                } else {
                    before
                }
            );
        }
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the endpoint command stores and samples exact affine values"
    )]
    fn timed_root_transform_is_inactive_before_its_anchor_and_preserves_existing_channels() {
        let bundle = imported_bundle();
        let original_channels = bundle.scene.animation_channels.clone();
        let original_target = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap()
            .clone();
        let command = timed_transform_command_for(&bundle, &original_target.id);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session
            .transform_scene_entity_at_time(command.clone())
            .unwrap();

        assert_eq!(
            &result.scene.animation_channels[..original_channels.len()],
            original_channels
        );
        assert_eq!(
            result
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == original_target.id)
                .unwrap(),
            &original_target
        );
        assert!(matches!(
            result.scene.animation_channels.last(),
            Some(AnimationChannelV1::AffineTransform {
                entity_id,
                keyframes,
                provenance_id,
                ..
            }) if entity_id == "later"
                && provenance_id == &command.provenance.id
                && keyframes[0].at == 1.0
                && keyframes[0].value.m11 == 1.5
                && keyframes[0].value.m22 == 1.5
                && keyframes[0].value.tx == 6.0
                && keyframes[0].value.ty == -3.75
                && keyframes[1].at == 2.0
                && keyframes[1].value == keyframes[0].value
        ));
        assert!(
            result
                .scene
                .required_capabilities
                .contains(&SceneCapabilityV1::AffineTransformAnimation)
        );

        let sample_transform = |time| {
            let packet = session
                .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "timed-transform-sample",
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
                .find(|draw| draw.entity_id() == "later")
                .unwrap()
            {
                poietra_scene_ir::RenderDrawV1::Path { transform, .. } => transform.clone(),
                _ => panic!("the endpoint target must remain a path draw"),
            }
        };
        let before = sample_transform(0.999_999);
        assert_eq!(
            (before.m11, before.m22, before.tx, before.ty),
            (1.0, 1.0, 3.0, -2.0)
        );
        let at = sample_transform(1.0);
        assert_eq!((at.m11, at.m22, at.tx, at.ty), (1.5, 1.5, 6.0, -3.75));
        assert_eq!(sample_transform(1.5), at);
    }

    #[test]
    fn invalid_or_ambiguous_timed_transforms_preserve_the_retained_scene() {
        let bundle = imported_bundle();
        let mut non_uniform = timed_transform_command_for(&bundle, "later");
        non_uniform.scale.as_mut().unwrap().y_factor = 1.25;
        assert!(matches!(
            rejected_timed_transform(bundle.clone(), non_uniform),
            TransformSceneEntityError::NonUniformFactor
        ));

        let mut at_scene_end = timed_transform_command_for(&bundle, "later");
        at_scene_end.at = bundle.scene.duration;
        assert!(matches!(
            rejected_timed_transform(bundle.clone(), at_scene_end),
            TransformSceneEntityError::InvalidAnchor
        ));

        let mut animated = bundle.clone();
        animated
            .scene
            .required_capabilities
            .push(SceneCapabilityV1::AffineTransformAnimation);
        animated.scene.required_capabilities.sort_unstable();
        let target_transform = animated
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap()
            .transform
            .clone();
        animated
            .scene
            .animation_channels
            .push(AnimationChannelV1::AffineTransform {
                entity_id: "later".to_owned(),
                id: "existing-root-transform".to_owned(),
                keyframes: vec![
                    KeyframeV1 {
                        at: 0.25,
                        easing_to_next: Some(EasingV1::Linear {}),
                        value: target_transform.clone(),
                    },
                    KeyframeV1 {
                        at: 0.75,
                        easing_to_next: None,
                        value: target_transform,
                    },
                ],
                provenance_id: animated.scene.provenance[0].id.clone(),
            });
        let animated_command = timed_transform_command_for(&animated, "later");
        assert!(matches!(
            rejected_timed_transform(animated, animated_command),
            TransformSceneEntityError::AnimatedTransformUnsupported(id) if id == "later"
        ));

        let nested = fixture_bundle("real-line-joints-v10.json");
        let child_id = nested
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.is_some())
            .unwrap()
            .id
            .clone();
        let mut nested_command = timed_transform_command_for(&nested, &child_id);
        nested_command.at = 0.5;
        assert!(matches!(
            rejected_timed_transform(nested, nested_command),
            TransformSceneEntityError::TargetIsNotRoot(id) if id == child_id
        ));
    }

    #[test]
    fn sets_all_three_real_line_joints_stroke_alphas_without_changing_other_child_state() {
        let bundle = real_line_joints_bundle();
        let root = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.is_none())
            .unwrap()
            .clone();
        let original_children = bundle.scene.entities[1..].to_vec();
        let command = paint_alpha_command_for(&bundle, &root.id);
        let expected_assets = bundle.assets.clone();
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session
            .set_subtree_vector_paint_alpha(command.clone())
            .unwrap();

        assert_eq!(result.scene.entities[0], root);
        for (changed, original) in result.scene.entities[1..].iter().zip(original_children) {
            let mut expected = original;
            let SceneAppearanceV1::Vector { fill, stroke, .. } = &mut expected.appearance else {
                panic!("the real LineJoints leaves must remain vector paint");
            };
            assert!(fill.is_none());
            stroke
                .as_mut()
                .expect("the real LineJoints leaves must retain their strokes")
                .color
                .alpha = command.alpha;
            expected.provenance_id.clone_from(&command.provenance.id);
            assert_eq!(changed, &expected);
        }
        assert_eq!(result.scene.provenance.last(), Some(&command.provenance));
        assert_eq!(
            result.scene.source,
            SceneSourceV1::StudioEditProgram {
                edit_program_version: ContractVersionV1,
                revision_hash: command.next_revision,
            }
        );
        assert_eq!(session.scene(), &result.scene);
        assert_eq!(session.assets(), &expected_assets);
        assert_eq!(session.retained_index_stats().build_count, 2);
    }

    #[test]
    fn paint_alpha_provenance_marks_only_vector_entities_whose_paint_changed() {
        let mut bundle = real_line_joints_bundle();
        let root_id = bundle.scene.entities[0].id.clone();
        let unchanged_id = bundle.scene.entities[1].id.clone();
        let unchanged_provenance = bundle.scene.entities[1].provenance_id.clone();
        let SceneAppearanceV1::Vector {
            stroke: Some(stroke),
            ..
        } = &mut bundle.scene.entities[1].appearance
        else {
            panic!("the real LineJoints first leaf must retain its stroke");
        };
        stroke.color.alpha = 0.25;
        let command = paint_alpha_command_for(&bundle, &root_id);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session
            .set_subtree_vector_paint_alpha(command.clone())
            .unwrap();

        assert_eq!(
            result
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == unchanged_id)
                .unwrap()
                .provenance_id,
            unchanged_provenance
        );
        assert!(
            result.scene.entities[2..]
                .iter()
                .all(|entity| entity.provenance_id == command.provenance.id)
        );
    }

    #[test]
    fn every_rejected_paint_alpha_preserves_the_real_retained_scene() {
        let bundle = real_line_joints_bundle();
        let root_id = bundle.scene.entities[0].id.clone();
        let child_id = bundle.scene.entities[1].id.clone();
        let command = paint_alpha_command_for(&bundle, &root_id);
        let mut rejected = Vec::new();

        let mut stale = command.clone();
        stale.expected_base_revision =
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned();
        rejected.push(stale);

        let mut invalid_revision = command.clone();
        invalid_revision.next_revision = "not-a-revision".to_owned();
        rejected.push(invalid_revision);

        let mut unchanged_revision = command.clone();
        unchanged_revision.next_revision = unchanged_revision.expected_base_revision.clone();
        rejected.push(unchanged_revision);

        let mut missing = command.clone();
        missing.root_entity_id = "missing".to_owned();
        rejected.push(missing);

        for alpha in [f64::NAN, f64::INFINITY, -0.1, 1.1] {
            let mut invalid_alpha = command.clone();
            invalid_alpha.alpha = alpha;
            rejected.push(invalid_alpha);
        }

        let mut wrong_origin = command.clone();
        wrong_origin.provenance.origin = ProvenanceOriginV1::Fixture;
        rejected.push(wrong_origin);

        let mut duplicate_provenance = command.clone();
        duplicate_provenance.provenance.id = bundle.scene.provenance[0].id.clone();
        rejected.push(duplicate_provenance);

        let mut child_target = command.clone();
        child_target.root_entity_id = child_id;
        rejected.push(child_target);

        let mut no_op = command;
        no_op.alpha = 1.0;
        rejected.push(no_op);

        for command in rejected {
            let _error = rejected_paint_alpha(real_line_joints_bundle(), command);
        }

        let image_bundle = fixture_bundle("png-alpha-edge-camera.json");
        let image_id = image_bundle.scene.entities[0].id.clone();
        let image_command = paint_alpha_command_for(&image_bundle, &image_id);
        assert!(matches!(
            rejected_paint_alpha(image_bundle, image_command),
            SetSubtreeVectorPaintAlphaError::UnsupportedSubtreeEntity(id) if id == image_id
        ));

        for (fixture, entity_id) in [
            ("dynamic-affine-camera.json", "dynamic-parent"),
            ("vector-appearance-square-circle.json", "shape"),
        ] {
            let animated_bundle = fixture_bundle(fixture);
            let command = paint_alpha_command_for(&animated_bundle, entity_id);
            assert!(matches!(
                rejected_paint_alpha(animated_bundle, command),
                SetSubtreeVectorPaintAlphaError::AnimatedPaintUnsupported(id)
                    if id == entity_id
            ));
        }
    }

    #[test]
    fn rejected_atomic_transforms_preserve_the_retained_scene() {
        let bundle = real_line_joints_bundle();
        let root_id = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.is_none())
            .unwrap()
            .id
            .clone();
        let command = transform_command_for(&bundle, &root_id);

        let mut stale = command.clone();
        stale.expected_base_revision = "f".repeat(64);
        assert!(matches!(
            rejected_transform(bundle.clone(), stale),
            TransformSceneEntityError::StaleBaseRevision
        ));

        let mut no_op = command.clone();
        no_op.intent = TransformSceneEntityIntent::Relative {
            delta: PointV1 { x: 0.0, y: 0.0 },
            scale: None,
        };
        assert!(matches!(
            rejected_transform(bundle.clone(), no_op),
            TransformSceneEntityError::NoOp
        ));

        let mut invalid_delta = command.clone();
        let TransformSceneEntityIntent::Relative { delta, .. } = &mut invalid_delta.intent else {
            unreachable!();
        };
        delta.x = f64::NAN;
        assert!(matches!(
            rejected_transform(bundle.clone(), invalid_delta),
            TransformSceneEntityError::InvalidDelta
        ));

        let mut identity_scale = command.clone();
        let TransformSceneEntityIntent::Relative { scale, .. } = &mut identity_scale.intent else {
            unreachable!();
        };
        let identity = scale.as_mut().unwrap();
        identity.x_factor = 1.0;
        identity.y_factor = 1.0;
        assert!(matches!(
            rejected_transform(bundle.clone(), identity_scale),
            TransformSceneEntityError::InvalidFactor
        ));

        let child_id = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.as_deref() == Some(root_id.as_str()))
            .unwrap()
            .id
            .clone();
        let ancestor_transformed = transform_command_for(&bundle, &child_id);
        assert!(matches!(
            rejected_transform(bundle, ancestor_transformed),
            TransformSceneEntityError::TransformedAncestorUnsupported(id) if id == root_id
        ));

        for (fixture, entity_id) in [
            ("dynamic-affine-camera.json", "dynamic-parent"),
            ("manim-motion-path.json", "mover"),
        ] {
            let animated = fixture_bundle(fixture);
            let command = transform_command_for(&animated, entity_id);
            assert!(matches!(
                rejected_transform(animated, command),
                TransformSceneEntityError::AnimatedTransformUnsupported(id) if id == entity_id
            ));
        }
    }

    #[test]
    fn animated_transform_targets_are_rejected_without_mutation() {
        for (fixture, entity_id) in [
            ("dynamic-affine-camera.json", "dynamic-parent"),
            ("manim-motion-path.json", "mover"),
        ] {
            let bundle = fixture_bundle(fixture);
            let expected_scene = bundle.scene.clone();
            let expected_assets = bundle.assets.clone();
            let mut session = EngineSessionV1::new(bundle).unwrap();
            let mut command = command();
            command.entity_id = entity_id.to_owned();
            command.expected_base_revision = session.scene().source.revision_hash().to_owned();

            assert!(matches!(
                session.rotate_scene_entity(command),
                Err(RotateSceneEntityError::AnimatedTransformUnsupported(target))
                    if target == entity_id
            ));
            assert_eq!(session.scene(), &expected_scene);
            assert_eq!(session.assets(), &expected_assets);
            assert_eq!(session.retained_index_stats().build_count, 1);
        }
    }

    #[test]
    fn every_rejected_rotation_preserves_the_retained_scene() {
        let mut rejected = Vec::new();

        let mut stale = command();
        stale.expected_base_revision =
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned();
        rejected.push(stale);

        let mut invalid_revision = command();
        invalid_revision.next_revision = "not-a-revision".to_owned();
        rejected.push(invalid_revision);

        let mut unchanged_revision = command();
        unchanged_revision.next_revision = BASE_REVISION.to_owned();
        rejected.push(unchanged_revision);

        let mut missing = command();
        missing.entity_id = "missing".to_owned();
        rejected.push(missing);

        let mut invalid_pivot = command();
        invalid_pivot.pivot.x = f64::NAN;
        rejected.push(invalid_pivot);

        let mut zero_angle = command();
        zero_angle.angle_radians = 0.0;
        rejected.push(zero_angle);

        let mut full_turn = command();
        full_turn.angle_radians = std::f64::consts::TAU;
        rejected.push(full_turn);

        let mut wrong_origin = command();
        wrong_origin.provenance.origin = ProvenanceOriginV1::Fixture;
        rejected.push(wrong_origin);

        let mut duplicate_provenance = command();
        duplicate_provenance.provenance.id = "fixture".to_owned();
        rejected.push(duplicate_provenance);

        for command in rejected {
            let bundle = imported_bundle();
            let expected_scene = bundle.scene.clone();
            let expected_assets = bundle.assets.clone();
            let mut session = EngineSessionV1::new(bundle).unwrap();

            assert!(session.rotate_scene_entity(command).is_err());
            assert_eq!(session.scene(), &expected_scene);
            assert_eq!(session.assets(), &expected_assets);
            assert_eq!(session.retained_index_stats().build_count, 1);
        }
    }

    #[test]
    fn applies_one_complete_studio_motion_through_canonical_identity_and_coordinates() {
        let bundle = static_imported_bundle();
        let ir_scene_id = bundle.scene.scene_id.clone();
        assert_ne!(ir_scene_id, "scene.py#CircleScene");
        let command = studio_motion_edit_command(&bundle);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_motion_edit(command).unwrap();

        assert_eq!(result.scene.scene_id, ir_scene_id);
        assert!((result.scene.duration - 3.0).abs() < f64::EPSILON);
        assert_eq!(
            result.scene.provenance.last().unwrap().id,
            format!("studio-motion:{NEXT_REVISION}")
        );
        let path = result
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
        let subpath = &path.subpaths[0];
        let segment = &subpath.segments[0];
        assert_eq!(subpath.start, PointV1 { x: 0.0, y: 0.0 });
        assert!((segment.control1.x - 2.0).abs() < 1e-12);
        assert!((segment.control1.y - 10.0 / 3.0).abs() < 1e-12);
        assert!((segment.control2.x - 4.0).abs() < 1e-12);
        assert!((segment.control2.y - 4.0).abs() < 1e-12);
        assert_eq!(segment.end, PointV1 { x: 6.0, y: 2.0 });
    }

    #[test]
    fn applies_two_sequenced_motions_in_one_program_with_one_timeline_insertion() {
        let bundle = static_imported_bundle();
        let command = two_motion_sequence_command(&bundle);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_motion_edit(command).unwrap();
        let (keyframes, path) = result
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::MotionPath {
                    entity_id,
                    keyframes,
                    path,
                    ..
                } if entity_id == "later" => Some((keyframes, path)),
                _ => None,
            })
            .unwrap();

        assert!((result.scene.duration - 3.25).abs() < f64::EPSILON);
        assert_eq!(path.subpaths[0].segments.len(), 2);
        assert_eq!(
            keyframes
                .iter()
                .map(|keyframe| keyframe.at)
                .collect::<Vec<_>>(),
            vec![0.5, 1.0, 1.25, 1.75]
        );
        let sampled_transform = |time| {
            let packet = session
                .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "multi-motion-program-sample",
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
                .find(|draw| draw.entity_id() == "later")
                .unwrap()
            {
                poietra_scene_ir::RenderDrawV1::Path { transform, .. } => transform.clone(),
                _ => panic!("motion target must remain a path draw"),
            }
        };
        for (time, expected) in [
            (0.5, PointV1 { x: 0.0, y: 0.0 }),
            (0.75, PointV1 { x: 3.0, y: 3.0 }),
            (1.0, PointV1 { x: 6.0, y: 2.0 }),
            (1.125, PointV1 { x: 6.0, y: 2.0 }),
            (1.5, PointV1 { x: 7.0, y: 3.5 }),
            (1.75, PointV1 { x: 6.0, y: 5.0 }),
        ] {
            let sampled = sampled_transform(time);
            assert!((sampled.tx - expected.x).abs() < 1e-10, "time={time}");
            assert!((sampled.ty - expected.y).abs() < 1e-10, "time={time}");
        }
    }

    #[test]
    fn applies_parallel_motion_buckets_in_time_order_with_one_timeline_insertion() {
        let bundle = static_imported_bundle();
        let mut command = two_motion_sequence_command(&bundle);
        let program = &mut command.programs[0];
        let StudioMotionOperation::CreateMotion { depends_on, .. } = &mut program.operations[1]
        else {
            unreachable!();
        };
        depends_on.clear();
        program
            .operations
            .push(StudioMotionOperation::CreateMotion {
                control_offset: PointV1 { x: 0.0, y: 0.0 },
                delta: PointV1 { x: 0.0, y: -80.0 },
                depends_on: vec![],
                easing: StudioMotionEasing::Smooth,
                id: "create-motion-parallel".to_owned(),
                interval: IntervalV1 {
                    end: 1.0,
                    start: 0.5,
                },
                origin: StudioAuthoringOrigin::DirectManipulation,
                target_entity_ids: vec!["source:stroke".to_owned()],
            });
        program.intent_count = 3;
        program.requested_execution = StudioProgramExecution::Parallel;
        program.schedule_edge_count = 0;
        program.schedule_mode = StudioProgramScheduleMode::Parallel;
        program.schedule_order = vec![
            "create-motion-second".to_owned(),
            "create-motion-parallel".to_owned(),
            "create-motion".to_owned(),
        ];
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_motion_edit(command).unwrap();
        let later = result
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::MotionPath {
                    entity_id,
                    keyframes,
                    path,
                    ..
                } if entity_id == "later" => Some((keyframes, path)),
                _ => None,
            })
            .unwrap();
        let stroke_keyframes = result
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::MotionPath {
                    entity_id,
                    keyframes,
                    ..
                } if entity_id == "stroke" => Some(keyframes),
                _ => None,
            })
            .unwrap();

        assert!((result.scene.duration - 3.25).abs() < f64::EPSILON);
        assert_eq!(later.1.subpaths[0].segments.len(), 2);
        assert_eq!(
            later
                .0
                .iter()
                .map(|keyframe| keyframe.at)
                .collect::<Vec<_>>(),
            vec![0.5, 1.0, 1.25, 1.75]
        );
        assert_eq!(
            stroke_keyframes
                .iter()
                .map(|keyframe| keyframe.at)
                .collect::<Vec<_>>(),
            vec![0.5, 1.0]
        );
    }

    #[test]
    fn rejects_ambiguous_or_invalid_second_motion_in_one_program_atomically() {
        let bundle = static_imported_bundle();
        let sequence = two_motion_sequence_command(&bundle);

        let mut overlapping_sequence = sequence.clone();
        let StudioMotionOperation::CreateMotion { interval, .. } =
            &mut overlapping_sequence.programs[0].operations[1]
        else {
            unreachable!();
        };
        interval.start = 0.75;

        let mut overlapping_parallel_buckets = overlapping_sequence.clone();
        let program = &mut overlapping_parallel_buckets.programs[0];
        let StudioMotionOperation::CreateMotion { depends_on, .. } = &mut program.operations[1]
        else {
            unreachable!();
        };
        depends_on.clear();
        program.requested_execution = StudioProgramExecution::Parallel;
        program.schedule_edge_count = 0;
        program.schedule_mode = StudioProgramScheduleMode::Parallel;
        program.schedule_order.reverse();

        let mut invalid_target = sequence.clone();
        let StudioMotionOperation::CreateMotion {
            target_entity_ids, ..
        } = &mut invalid_target.programs[0].operations[1]
        else {
            unreachable!();
        };
        *target_entity_ids = vec!["source:missing".to_owned()];

        let mut overlapping_parallel = sequence;
        let program = &mut overlapping_parallel.programs[0];
        let StudioMotionOperation::CreateMotion {
            depends_on,
            easing,
            interval,
            ..
        } = &mut program.operations[1]
        else {
            unreachable!();
        };
        depends_on.clear();
        *easing = StudioMotionEasing::Smooth;
        *interval = IntervalV1 {
            end: 1.0,
            start: 0.5,
        };
        program.requested_execution = StudioProgramExecution::Parallel;
        program.schedule_edge_count = 0;
        program.schedule_mode = StudioProgramScheduleMode::Parallel;

        for command in [
            overlapping_sequence,
            overlapping_parallel_buckets,
            invalid_target,
            overlapping_parallel,
        ] {
            let expected_scene = bundle.scene.clone();
            let expected_assets = bundle.assets.clone();
            let mut session = EngineSessionV1::new(bundle.clone()).unwrap();

            assert!(matches!(
                session.apply_studio_motion_edit(command),
                Err(ApplyStudioMotionEditError::Unsupported)
            ));
            assert_eq!(session.scene(), &expected_scene);
            assert_eq!(session.assets(), &expected_assets);
            assert_eq!(session.retained_index_stats().build_count, 1);
        }
    }

    #[test]
    fn stitches_same_anchor_motions_for_one_entity_and_samples_each_curve() {
        let bundle = static_imported_bundle();
        let mut command = studio_motion_edit_command(&bundle);
        let template = command.programs[0].clone();
        command.programs = vec![
            studio_motion_program(
                &template,
                "first",
                0.5,
                1.0,
                vec!["source:later".to_owned()],
                PointV1 { x: 240.0, y: -80.0 },
                PointV1 { x: 0.0, y: -160.0 },
                StudioMotionEasing::Smooth,
            ),
            studio_motion_program(
                &template,
                "second",
                0.5,
                1.0,
                vec!["source:later".to_owned()],
                PointV1 { x: 0.0, y: -120.0 },
                PointV1 { x: 80.0, y: 0.0 },
                StudioMotionEasing::Linear,
            ),
        ];
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_motion_edit(command).unwrap();
        let motions = result
            .scene
            .animation_channels
            .iter()
            .filter_map(|channel| match channel {
                AnimationChannelV1::MotionPath {
                    entity_id,
                    keyframes,
                    path,
                    ..
                } => Some((entity_id, keyframes, path)),
                _ => None,
            })
            .collect::<Vec<_>>();

        assert_eq!(motions.len(), 1);
        let (entity_id, keyframes, path) = motions[0];
        assert_eq!(entity_id, "later");
        assert_eq!(path.subpaths[0].segments.len(), 2);
        assert_eq!(
            keyframes
                .iter()
                .map(|keyframe| keyframe.at)
                .collect::<Vec<_>>(),
            vec![0.5, 1.0, 1.5]
        );
        assert!(matches!(
            keyframes[0].easing_to_next,
            Some(EasingV1::ManimSmooth {})
        ));
        assert!(matches!(
            keyframes[1].easing_to_next,
            Some(EasingV1::Linear {})
        ));
        assert!((result.scene.duration - 3.0).abs() < f64::EPSILON);

        let sampled_transform = |time| {
            let packet = session
                .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "stitched-motion-sample",
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
                .find(|draw| draw.entity_id() == "later")
                .unwrap()
            {
                poietra_scene_ir::RenderDrawV1::Path { transform, .. } => transform.clone(),
                _ => panic!("motion target must remain a path draw"),
            }
        };
        for (time, expected) in [
            (0.5, PointV1 { x: 0.0, y: 0.0 }),
            (0.75, PointV1 { x: 3.0, y: 3.0 }),
            (1.0, PointV1 { x: 6.0, y: 2.0 }),
            (1.25, PointV1 { x: 7.0, y: 3.5 }),
            (1.5, PointV1 { x: 6.0, y: 5.0 }),
        ] {
            let sampled = sampled_transform(time);
            assert!((sampled.tx - expected.x).abs() < 1e-10, "time={time}");
            assert!((sampled.ty - expected.y).abs() < 1e-10, "time={time}");
        }
    }

    #[test]
    fn orders_distinct_root_motions_by_source_anchor_and_rebases_the_later_interval() {
        let bundle = static_imported_bundle();
        let mut command = studio_motion_edit_command(&bundle);
        let template = command.programs[0].clone();
        command.programs = vec![
            studio_motion_program(
                &template,
                "later-anchor",
                1.0,
                1.5,
                vec!["source:stroke".to_owned()],
                PointV1 { x: 0.0, y: -40.0 },
                PointV1 { x: 0.0, y: 0.0 },
                StudioMotionEasing::Linear,
            ),
            studio_motion_program(
                &template,
                "earlier-anchor",
                0.25,
                0.75,
                vec!["source:later".to_owned()],
                PointV1 { x: 40.0, y: 0.0 },
                PointV1 { x: 0.0, y: 0.0 },
                StudioMotionEasing::Smooth,
            ),
        ];
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_motion_edit(command).unwrap();
        let motions = result
            .scene
            .animation_channels
            .iter()
            .filter_map(|channel| match channel {
                AnimationChannelV1::MotionPath {
                    entity_id,
                    keyframes,
                    path,
                    ..
                } => Some((entity_id.as_str(), keyframes, path)),
                _ => None,
            })
            .collect::<Vec<_>>();

        assert!((result.scene.duration - 3.0).abs() < f64::EPSILON);
        assert_eq!(motions.len(), 2);
        assert_eq!(motions[0].0, "later");
        assert_eq!(
            motions[0]
                .1
                .iter()
                .map(|keyframe| keyframe.at)
                .collect::<Vec<_>>(),
            vec![0.25, 0.75]
        );
        assert_eq!(motions[0].2.subpaths[0].segments.len(), 1);
        assert_eq!(motions[1].0, "stroke");
        assert_eq!(
            motions[1]
                .1
                .iter()
                .map(|keyframe| keyframe.at)
                .collect::<Vec<_>>(),
            vec![1.5, 2.0]
        );
        assert_eq!(motions[1].2.subpaths[0].segments.len(), 1);
    }

    #[test]
    fn keeps_a_stationary_keyframe_across_gaps_between_motions() {
        let bundle = static_imported_bundle();
        let mut command = studio_motion_edit_command(&bundle);
        let template = command.programs[0].clone();
        command.programs = vec![
            studio_motion_program(
                &template,
                "before-gap",
                0.25,
                0.75,
                vec!["source:later".to_owned()],
                PointV1 { x: 40.0, y: 0.0 },
                PointV1 { x: 0.0, y: 0.0 },
                StudioMotionEasing::Smooth,
            ),
            studio_motion_program(
                &template,
                "after-gap",
                1.25,
                1.75,
                vec!["source:later".to_owned()],
                PointV1 { x: 0.0, y: -40.0 },
                PointV1 { x: 0.0, y: 0.0 },
                StudioMotionEasing::Linear,
            ),
        ];
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_studio_motion_edit(command).unwrap();
        let keyframes = result
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::MotionPath { keyframes, .. } => Some(keyframes),
                _ => None,
            })
            .unwrap();

        assert_eq!(
            keyframes
                .iter()
                .map(|keyframe| keyframe.at)
                .collect::<Vec<_>>(),
            vec![0.25, 0.75, 1.75, 2.25]
        );
        assert!((keyframes[1].value - keyframes[2].value).abs() < f64::EPSILON);
        assert!(matches!(
            keyframes[1].easing_to_next,
            Some(EasingV1::Linear {})
        ));
        assert!(matches!(
            keyframes[2].easing_to_next,
            Some(EasingV1::Linear {})
        ));
    }

    #[test]
    fn rejects_a_later_invalid_or_duplicate_motion_without_mutating_the_scene() {
        let bundle = static_imported_bundle();
        let mut valid = studio_motion_edit_command(&bundle);
        let template = valid.programs[0].clone();
        valid.programs = vec![
            studio_motion_program(
                &template,
                "first-valid",
                0.25,
                0.75,
                vec!["source:later".to_owned()],
                PointV1 { x: 40.0, y: 0.0 },
                PointV1 { x: 0.0, y: 0.0 },
                StudioMotionEasing::Smooth,
            ),
            studio_motion_program(
                &template,
                "second-valid",
                1.0,
                1.5,
                vec!["source:stroke".to_owned()],
                PointV1 { x: 0.0, y: -40.0 },
                PointV1 { x: 0.0, y: 0.0 },
                StudioMotionEasing::Linear,
            ),
        ];
        let mut invalid_target = valid.clone();
        let StudioMotionOperation::CreateMotion {
            target_entity_ids, ..
        } = &mut invalid_target.programs[1].operations[0]
        else {
            unreachable!();
        };
        *target_entity_ids = vec!["source:missing".to_owned()];

        let mut duplicate_id = valid;
        let first_id = duplicate_id.programs[0].operations[0].id().to_owned();
        let StudioMotionOperation::CreateMotion { id, .. } =
            &mut duplicate_id.programs[1].operations[0]
        else {
            unreachable!();
        };
        *id = first_id.clone();
        duplicate_id.programs[1].schedule_order = vec![first_id];

        for command in [invalid_target, duplicate_id] {
            let expected_scene = bundle.scene.clone();
            let expected_assets = bundle.assets.clone();
            let mut session = EngineSessionV1::new(bundle.clone()).unwrap();

            assert!(matches!(
                session.apply_studio_motion_edit(command),
                Err(ApplyStudioMotionEditError::Unsupported)
            ));
            assert_eq!(session.scene(), &expected_scene);
            assert_eq!(session.assets(), &expected_assets);
            assert_eq!(session.retained_index_stats().build_count, 1);
        }
    }

    #[test]
    fn rejected_studio_motion_facts_preserve_the_retained_scene() {
        let bundle = static_imported_bundle();
        let mut rejected = Vec::new();

        let mut wrong_anchor = studio_motion_edit_command(&bundle);
        wrong_anchor.programs[0].anchor_resolved_seconds += 0.25;
        rejected.push(wrong_anchor);

        let mut wrong_schedule = studio_motion_edit_command(&bundle);
        wrong_schedule.programs[0].schedule_order[0] = "foreign".to_owned();
        rejected.push(wrong_schedule);

        let mut missing_dependency = studio_motion_edit_command(&bundle);
        let StudioMotionOperation::CreateMotion { depends_on, .. } =
            &mut missing_dependency.programs[0].operations[0]
        else {
            unreachable!();
        };
        *depends_on = vec!["missing-operation".to_owned()];
        rejected.push(missing_dependency);

        let mut mixed = studio_motion_edit_command(&bundle);
        mixed.programs[0]
            .operations
            .push(StudioMotionOperation::Unsupported {
                depends_on: vec![],
                id: "unsupported".to_owned(),
                interval: IntervalV1 {
                    end: 0.5,
                    start: 0.5,
                },
                origin: StudioAuthoringOrigin::DirectManipulation,
            });
        mixed.programs[0]
            .schedule_order
            .push("unsupported".to_owned());
        mixed.programs[0].schedule_edge_count = 1;
        rejected.push(mixed);

        let mut wrong_binding = studio_motion_edit_command(&bundle);
        wrong_binding.source_runtime_bindings[0].source_name = "other-source".to_owned();
        rejected.push(wrong_binding);

        for command in rejected {
            assert!(matches!(
                rejected_studio_motion(bundle.clone(), command),
                ApplyStudioMotionEditError::Unsupported
            ));
        }
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "exact authored values and sampled endpoints verify the complete atomic motion"
    )]
    fn creates_one_quadratic_motion_channel_per_root_and_samples_it() {
        let bundle = imported_bundle();
        let command = motion_command(&bundle);
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.create_scene_motion(command.clone()).unwrap();
        let motion_channels: Vec<_> = result
            .scene
            .animation_channels
            .iter()
            .filter_map(|channel| match channel {
                AnimationChannelV1::MotionPath {
                    entity_id,
                    id,
                    keyframes,
                    orient_to_path,
                    parameterization,
                    path,
                    provenance_id,
                } => Some((
                    entity_id,
                    id,
                    keyframes,
                    orient_to_path,
                    parameterization,
                    path,
                    provenance_id,
                )),
                _ => None,
            })
            .collect();

        assert_eq!(motion_channels.len(), 2);
        for (index, (entity_id, id, keyframes, orient, parameterization, path, provenance)) in
            motion_channels.into_iter().enumerate()
        {
            assert_eq!(entity_id, &command.target_entity_ids[index]);
            assert_eq!(
                id,
                if index == 0 {
                    "studio-motion"
                } else {
                    "studio-motion-1"
                }
            );
            assert_eq!(keyframes[0].at, 0.5);
            assert_eq!(keyframes[0].value, 0.0);
            assert!(matches!(
                keyframes[0].easing_to_next,
                Some(EasingV1::ManimSmooth {})
            ));
            assert_eq!(keyframes[1].at, 1.5);
            assert_eq!(keyframes[1].value, 1.0);
            assert!(!orient);
            assert_eq!(
                *parameterization,
                Some(MotionPathParameterizationV1::ManimPointFromProportionV1)
            );
            assert_eq!(provenance, &command.provenance.id);
            let subpath = &path.subpaths[0];
            let segment = &subpath.segments[0];
            let start = if index == 0 {
                PointV1 { x: 3.0, y: -2.0 }
            } else {
                PointV1 { x: 0.0, y: 0.0 }
            };
            assert_eq!(subpath.start, start);
            assert!((segment.control1.x - (start.x + 2.0)).abs() < 1e-12);
            assert!((segment.control1.y - (start.y + 10.0 / 3.0)).abs() < 1e-12);
            assert!((segment.control2.x - (start.x + 4.0)).abs() < 1e-12);
            assert!((segment.control2.y - (start.y + 4.0)).abs() < 1e-12);
            assert_eq!(
                segment.end,
                PointV1 {
                    x: start.x + 6.0,
                    y: start.y + 2.0,
                }
            );
        }
        assert!(
            result
                .scene
                .required_capabilities
                .contains(&SceneCapabilityV1::MotionPathAnimation)
        );
        assert_eq!(result.scene.duration, 3.0);
        assert_eq!(
            result
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == "later")
                .unwrap()
                .lifetimes[0]
                .end,
            3.0
        );
        assert!(matches!(
            &result.scene.animation_channels[0],
            AnimationChannelV1::Opacity { keyframes, .. }
                if keyframes[0].at == 0.0 && keyframes[1].at == 3.0
        ));
        assert_eq!(result.scene.provenance.last(), Some(&command.provenance));
        assert_eq!(session.retained_index_stats().build_count, 2);

        let sampled_transform = |time| {
            let packet = session
                .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "authored-motion-sample",
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
                .find(|draw| draw.entity_id() == "later")
                .unwrap()
            {
                poietra_scene_ir::RenderDrawV1::Path { transform, .. } => transform.clone(),
                _ => panic!("motion target must remain a path draw"),
            }
        };
        assert_eq!(
            (sampled_transform(0.25).tx, sampled_transform(0.25).ty),
            (3.0, -2.0)
        );
        assert_eq!(
            (sampled_transform(0.5).tx, sampled_transform(0.5).ty),
            (3.0, -2.0)
        );
        let midpoint = sampled_transform(1.0);
        assert!((midpoint.tx - 6.0).abs() < 1e-12);
        assert!((midpoint.ty - 1.0).abs() < 1e-12);
        assert_eq!(
            (sampled_transform(1.5).tx, sampled_transform(1.5).ty),
            (9.0, 0.0)
        );
    }

    #[test]
    fn rejected_motion_commands_preserve_the_retained_scene() {
        let bundle = imported_bundle();

        let mut duplicate = motion_command(&bundle);
        duplicate.target_entity_ids = vec!["later".to_owned(), "later".to_owned()];
        assert!(matches!(
            rejected_motion(bundle.clone(), duplicate),
            ApplyStudioMotionEditError::DuplicateTarget(id) if id == "later"
        ));

        let mut no_op = motion_command(&bundle);
        no_op.delta = PointV1 { x: 0.0, y: 0.0 };
        no_op.control_offset = PointV1 { x: 0.0, y: 0.0 };
        assert!(matches!(
            rejected_motion(bundle.clone(), no_op),
            ApplyStudioMotionEditError::InvalidMotion
        ));

        let mut inactive_bundle = bundle.clone();
        inactive_bundle
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == "later")
            .unwrap()
            .lifetimes[0]
            .end = 1.0;
        let inactive = motion_command(&inactive_bundle);
        assert!(matches!(
            rejected_motion(inactive_bundle, inactive),
            ApplyStudioMotionEditError::TargetInactive(id) if id == "later"
        ));

        let animated = fixture_bundle("manim-motion-path.json");
        let mut already_animated = motion_command(&animated);
        already_animated.target_entity_ids = vec!["mover".to_owned()];
        assert!(matches!(
            rejected_motion(animated, already_animated),
            ApplyStudioMotionEditError::AnimatedTransformUnsupported(id) if id == "mover"
        ));

        let nested = fixture_bundle("real-line-joints-v10.json");
        let child_id = nested
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.is_some())
            .unwrap()
            .id
            .clone();
        let mut nested_target = motion_command(&nested);
        nested_target.interval = IntervalV1 {
            start: 0.0,
            end: 1.0,
        };
        nested_target.target_entity_ids = vec![child_id.clone()];
        assert!(matches!(
            rejected_motion(nested, nested_target),
            ApplyStudioMotionEditError::TargetIsNotRoot(id) if id == child_id
        ));
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
    #[allow(
        clippy::float_cmp,
        reason = "the normalized projection stores exact timeline values"
    )]
    fn math_tex_transform_projector_authorizes_one_and_two_step_chains() {
        let command = math_tex_transform_command();
        let duration = static_imported_math_tex_bundle().scene.duration;
        let entities = math_tex_transform_projection_entities(duration);

        let two_step =
            project_studio_math_tex_transform_programs(duration, &command.programs, &entities)
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
            project_studio_math_tex_transform_programs(duration, &[one_step_program], &entities)
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
        command.programs = vec![math_tex_transform_program(
            "math-tex-transform",
            0.25,
            operations,
        )];
        let duration = static_imported_math_tex_bundle().scene.duration;
        let projection = project_studio_math_tex_transform_programs(
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
                easing: StudioMotionEasing::Smooth,
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
    fn math_tex_transform_projector_rebases_a_later_motion_program() {
        let command = math_tex_transform_command();
        let programs = vec![
            command.programs[0].clone(),
            math_tex_transform_program(
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

        let projection = project_studio_math_tex_transform_programs(
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
            math_tex_transform_program("reverse", 0.25, vec![reverse_motion, transform.clone()]);

        let mut parallel =
            math_tex_transform_program("parallel", 0.25, vec![transform.clone(), motion.clone()]);
        parallel.requested_execution = StudioProgramExecution::Parallel;

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
            vec![math_tex_transform_program(
                "wrong-target",
                0.25,
                vec![transform.clone(), wrong_target],
            )],
            vec![math_tex_transform_program(
                "multiple-motion",
                0.25,
                vec![transform.clone(), motion, second_motion],
            )],
        ] {
            assert!(matches!(
                project_studio_math_tex_transform_programs(duration, &programs, &entities),
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
                project_studio_math_tex_transform_programs(
                    duration,
                    &programs,
                    &candidate_entities,
                ),
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
        assert!(studio_math_tex_transform_program_is_closed(
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
    fn math_tex_transform_stably_rebases_two_same_anchor_programs() {
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
            math_tex_transform_program("first", 0.25, vec![first]),
            math_tex_transform_program("second", 0.25, vec![second]),
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

    #[test]
    fn motion_projector_expands_multi_target_and_accumulates_sequential_segments() {
        let bundle = static_imported_bundle();
        let command = two_motion_sequence_command(&bundle);
        let projection = project_studio_motion_edit(&ProjectStudioMotionEditCommand {
            base_duration: bundle.scene.duration,
            batch: StudioMotionProjectionBatch::Standalone {
                programs: command.programs,
                studio_entities: vec![
                    StudioMotionProjectionEntityIdentity {
                        identity: command.studio_entities[0].clone(),
                        lifetime: vec![IntervalV1 {
                            end: bundle.scene.duration,
                            start: 0.0,
                        }],
                        position: PointV1 { x: 320.0, y: 180.0 },
                    },
                    StudioMotionProjectionEntityIdentity {
                        identity: command.studio_entities[1].clone(),
                        lifetime: vec![IntervalV1 {
                            end: bundle.scene.duration,
                            start: 0.0,
                        }],
                        position: PointV1 { x: 100.0, y: 80.0 },
                    },
                ],
            },
        })
        .unwrap();

        assert_eq!(projection.insertions.len(), 1);
        assert_eq!(projection.motions.len(), 2);
        assert_eq!(projection.motions[0].from, PointV1 { x: 320.0, y: 180.0 });
        assert_eq!(projection.motions[0].to, PointV1 { x: 560.0, y: 100.0 });
        assert_eq!(projection.motions[1].from, projection.motions[0].to);
        assert_eq!(projection.motions[1].to, PointV1 { x: 560.0, y: -20.0 });
    }

    #[test]
    fn static_root_motion_projector_uses_the_preceding_position_and_only_real_insertions() {
        let bundle = static_imported_bundle();
        let mut command = static_root_position_command();
        command
            .programs
            .push(static_root_motion_program(vec!["source:circle".to_owned()]));
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

    #[test]
    fn creation_projector_rebases_fade_and_motion_from_the_created_position() {
        let bundle = static_imported_bundle();
        let entity_id = "tx:create/entity:circle";
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        command
            .programs
            .push(studio_created_motion_program(vec![entity_id.to_owned()]));
        let projection =
            project_studio_creation_programs(bundle.scene.duration, &command.programs).unwrap();

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
