use std::collections::BTreeSet;

use poietra_scene_ir::{
    AffineTransformV1, AnimationChannelV1, ContractVersionV1, CubicPathV1, CubicSegmentV1,
    CubicSubpathV1, EasingV1, FidelityV1, FillRuleV1, FillStyleV1, IntervalV1, KeyframeV1,
    MotionPathParameterizationV1, PointV1, ProvenanceOriginV1, ProvenanceRecordV1, RgbaColorV1,
    SceneAppearanceV1, SceneCapabilityV1, SceneEntityV1, SceneGeometryV1, SceneIrBundleV1,
    SceneSourceV1, StrokeCapV1, StrokeJoinV1, StrokeStyleV1,
};
use serde::Deserialize;

use crate::{EngineSessionV1, EvaluationError};

const ROTATION_NOOP_EPSILON: f64 = 1e-12;
const TIMELINE_ANCHOR_EPSILON: f64 = 0.0005;

#[derive(Clone, Debug, PartialEq)]
enum CreateSceneEntityGeometry {
    Circle { radius: f64 },
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
    next_revision: String,
    provenance: ProvenanceRecordV1,
    timeline_insertions: Vec<SceneTimelineInsertion>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum StudioMotionEasing {
    Linear,
    Smooth,
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
        easing: StudioMotionEasing,
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
        target_entity_ids: Vec<String>,
    },
    Unsupported {
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
    },
}

impl StudioMotionOperation {
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
    pub anchor_seconds: f64,
    pub lowering_supported: bool,
    pub operations: Vec<StudioMotionOperation>,
    pub origin: StudioAuthoringOrigin,
    pub schedule_order: Vec<String>,
    pub validation_valid: bool,
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
pub struct StudioMotionSourceBinding {
    pub runtime_entity_id: String,
    pub source_identity_key: String,
    pub source_name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStudioMotionEditCommand {
    pub base_studio_scene_id: String,
    pub evaluated_duration: f64,
    pub evaluated_scene_id: String,
    pub expected_base_revision: String,
    pub frame: StudioAuthoringSize,
    pub next_revision: String,
    pub programs: Vec<StudioMotionProgram>,
    pub source_runtime_bindings: Vec<StudioMotionSourceBinding>,
    pub studio_entities: Vec<StudioMotionEntityIdentity>,
    pub viewport: StudioAuthoringSize,
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum StudioBoundEntityExecution {
    Parallel,
    Sequence,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum StudioBoundEntityScheduleMode {
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
pub enum StudioBoundEntityAnchorSource {
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
    pub validation_valid: bool,
}

/// One complete normalized Studio request plus integration-verified binding candidates.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStudioBoundEntityEditCommand {
    pub base_studio_scene_id: String,
    pub candidates: Vec<StudioBoundEntityEditCandidate>,
    pub evaluated_duration: f64,
    pub evaluated_scene_id: String,
    pub expected_base_revision: String,
    pub frame: StudioAuthoringSize,
    pub next_revision: String,
    pub programs: Vec<StudioBoundEntityProgram>,
    pub viewport: StudioAuthoringSize,
}

pub type StaticRootTransformOrigin = StudioAuthoringOrigin;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum StudioAuthoringEntityKind {
    Circle,
    Image,
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

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioAuthoringDimensions {
    pub height: Option<f64>,
    pub radius: Option<f64>,
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
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StaticRootTransformOperation {
    pub anchor_seconds: f64,
    pub entity_id: String,
    pub id: String,
    pub interval: IntervalV1,
    #[serde(flatten)]
    pub kind: StaticRootTransformOperationKind,
    pub lowering_supported: bool,
    pub origin: StaticRootTransformOrigin,
    pub program_origin: StaticRootTransformOrigin,
    pub validation_valid: bool,
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
    pub next_revision: String,
    pub operations: Vec<StaticRootTransformOperation>,
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
        event_kind: StudioTimelineEventKind,
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
        purpose: Option<StudioTimelinePurpose>,
    },
    TrimSceneDuration {
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
        removed_duration: f64,
        target_duration: f64,
        wait_operation_ids: Vec<String>,
    },
    Unsupported {
        id: String,
        interval: IntervalV1,
        origin: StudioAuthoringOrigin,
    },
}

impl StudioTimelineOperation {
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
    pub absolute_source_seconds: Option<f64>,
    pub lowering_supported: bool,
    pub operations: Vec<StudioTimelineOperation>,
    pub origin: StudioAuthoringOrigin,
    pub resolved_seconds: f64,
    pub schedule_order: Vec<String>,
    pub validation_valid: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStudioTimelineEditCommand {
    pub base_studio_scene_id: String,
    pub evaluated_duration: f64,
    pub evaluated_scene_id: String,
    pub expected_base_revision: String,
    pub next_revision: String,
    pub programs: Vec<StudioTimelineProgram>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationEntitySpec {
    pub dimensions: StudioAuthoringDimensions,
    pub id: String,
    pub kind: StudioAuthoringEntityKind,
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
        relative_factor: Option<f64>,
    },
    Resize {
        shape: StudioAuthoringEntityKind,
        to_dimensions: StudioAuthoringDimensions,
        to_position: PointV1,
    },
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StudioCreationOperation {
    pub entity_id: Option<String>,
    pub id: String,
    pub interval: IntervalV1,
    #[serde(flatten)]
    pub kind: StudioCreationOperationKind,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationProgram {
    pub anchor_seconds: f64,
    pub lowering_supported: bool,
    pub operations: Vec<StudioCreationOperation>,
    pub schedule_order: Vec<String>,
    pub transaction_id: String,
    pub validation_valid: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationEvaluatedEntity {
    pub content_sample_tex_parts: Vec<Option<Vec<String>>>,
    pub content_tex_parts: Option<Vec<String>>,
    pub id: String,
    pub kind: StudioAuthoringEntityKind,
    pub lifetimes: Vec<IntervalV1>,
    pub object_graph_key: String,
    pub source_identity: Option<String>,
    pub transaction_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationEvaluatedEvent {
    pub interval: Option<IntervalV1>,
    pub operation_id: Option<String>,
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
    pub evaluated_duration: f64,
    pub evaluated_entities: Vec<StudioCreationEvaluatedEntity>,
    pub evaluated_events: Vec<StudioCreationEvaluatedEvent>,
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
    #[error("the Scene containing the created entities failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
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
    #[error("the normalized Studio edit does not authorize one static imported root transform")]
    Unsupported,
    #[error(transparent)]
    Transform(#[from] TransformSceneEntityError),
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
        SceneGeometryV1::CubicPath { path } => {
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
        SceneGeometryV1::Group {} | SceneGeometryV1::Line { .. } => None,
    }
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

fn studio_motion_program_is_closed(program: &StudioMotionProgram) -> bool {
    let Some(operation) = program.operations.first() else {
        return false;
    };
    program.operations.len() == 1
        && program.schedule_order.len() == 1
        && program.schedule_order[0] == operation.id()
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
    if !program.validation_valid
        || program.intent_count != 1
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
    if program.operations.is_empty() || program.schedule_order.len() != program.operations.len() {
        return false;
    }
    let operation_ids = program
        .operations
        .iter()
        .map(|operation| operation.id.as_str())
        .collect::<BTreeSet<_>>();
    let scheduled_ids = program
        .schedule_order
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    operation_ids.len() == program.operations.len()
        && scheduled_ids.len() == program.schedule_order.len()
        && operation_ids == scheduled_ids
}

#[allow(
    clippy::float_cmp,
    reason = "an evaluated instantaneous operation is represented by one exact zero-width interval"
)]
fn studio_creation_event_start(
    events: &[StudioCreationEvaluatedEvent],
    operation_id: &str,
) -> Option<f64> {
    let mut matching = events
        .iter()
        .filter(|event| event.operation_id.as_deref() == Some(operation_id));
    let interval = matching.next()?.interval.as_ref()?;
    (matching.next().is_none() && interval.start.is_finite() && interval.start == interval.end)
        .then_some(interval.start)
}

struct PendingStudioCreation {
    current_dimensions: StudioAuthoringDimensions,
    fade_end: Option<f64>,
    initial_dimensions: StudioAuthoringDimensions,
    initial_position: PointV1,
    instant_at: Option<f64>,
    kind: StudioAuthoringEntityKind,
    lifetime: IntervalV1,
    position: PointV1,
    scale: f64,
    spec: StudioCreationEntitySpec,
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
        StaticRootTransformEntityKind::MathTex => {
            matches!(entity.geometry, SceneGeometryV1::CubicPath { .. })
                && matches!(entity.appearance, SceneAppearanceV1::Vector { .. })
        }
        StaticRootTransformEntityKind::Other => true,
    }
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

fn studio_duration_matches(left: f64, right: f64) -> bool {
    left.is_finite() && right.is_finite() && (left - right).abs() < TIMELINE_ANCHOR_EPSILON
}

fn studio_timeline_program_is_closed(program: &StudioTimelineProgram) -> bool {
    let Some(operation) = program.operations.first() else {
        return false;
    };
    program.operations.len() == 1
        && program.schedule_order.len() == 1
        && program.schedule_order[0] == operation.id()
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
        || (resolved_duration - target_duration).abs() >= TIMELINE_ANCHOR_EPSILON
    {
        return Err(ApplyStudioTimelineEditError::InvalidTrim);
    }
    let mut remaining = removed_duration;
    let mut removal_cursor = inserted_waits
        .last()
        .map(|wait| wait.end)
        .ok_or(ApplyStudioTimelineEditError::InvalidTrim)?;
    if (removal_cursor - at).abs() >= TIMELINE_ANCHOR_EPSILON {
        return Err(ApplyStudioTimelineEditError::InvalidTrim);
    }
    while remaining > TIMELINE_ANCHOR_EPSILON {
        let Some(wait) = inserted_waits.last() else {
            return Err(ApplyStudioTimelineEditError::InvalidTrim);
        };
        let available = wait.end - wait.start;
        if available <= 0.0 {
            inserted_waits.pop();
            continue;
        }
        if (wait.end - removal_cursor).abs() >= TIMELINE_ANCHOR_EPSILON {
            return Err(ApplyStudioTimelineEditError::InvalidTrim);
        }
        let removed = available.min(remaining);
        let removal_end = wait.end;
        let removal_start = removal_end - removed;
        remove_scene_time(scene, removal_start, removal_end);
        for wait in inserted_waits.iter_mut() {
            wait.start = time_after_removal(wait.start, removal_start, removal_end);
            wait.end = time_after_removal(wait.end, removal_start, removal_end);
        }
        inserted_waits.retain(|wait| wait.end > wait.start);
        removal_cursor = removal_start;
        remaining = (remaining - removed).max(0.0);
    }
    if (scene.duration - target_duration).abs() >= TIMELINE_ANCHOR_EPSILON {
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

fn quadratic_motion_path(start: PointV1, delta: &PointV1, control_offset: &PointV1) -> CubicPathV1 {
    let control_offset_x = 2.0 * control_offset.x / 3.0;
    let control_offset_y = 2.0 * control_offset.y / 3.0;
    CubicPathV1 {
        subpaths: vec![CubicSubpathV1 {
            closed: false,
            segments: vec![CubicSegmentV1 {
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
            }],
            start,
        }],
    }
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
    #[allow(
        clippy::too_many_lines,
        reason = "the closed timeline authority remains one auditable ordering and rebase state machine"
    )]
    pub fn apply_studio_timeline_edit(
        &mut self,
        command: ApplyStudioTimelineEditCommand,
    ) -> Result<SceneIrBundleV1, ApplyStudioTimelineEditError> {
        let ApplyStudioTimelineEditCommand {
            base_studio_scene_id,
            evaluated_duration,
            evaluated_scene_id,
            expected_base_revision,
            next_revision,
            programs,
        } = command;
        let scene = self.scene();
        if !matches!(
            scene.source,
            SceneSourceV1::ImportedManimServerSnapshot { .. }
        ) || !scene.animation_channels.is_empty()
            || base_studio_scene_id != evaluated_scene_id
            || !evaluated_duration.is_finite()
            || programs.is_empty()
        {
            return Err(ApplyStudioTimelineEditError::Unsupported);
        }
        let mut operation_ids = BTreeSet::new();
        for program in &programs {
            let Some(source_seconds) = program.absolute_source_seconds else {
                return Err(ApplyStudioTimelineEditError::Unsupported);
            };
            let Some(operation) = program.operations.first() else {
                return Err(ApplyStudioTimelineEditError::Unsupported);
            };
            if !source_seconds.is_finite()
                || source_seconds < 0.0
                || !program.resolved_seconds.is_finite()
                || program.resolved_seconds < 0.0
                || !program.validation_valid
                || !program.lowering_supported
                || program.origin != StudioAuthoringOrigin::StudioDefault
                || !studio_timeline_program_is_closed(program)
                || operation.origin() != StudioAuthoringOrigin::StudioDefault
                || operation.id().is_empty()
                || !operation_ids.insert(operation.id())
            {
                return Err(ApplyStudioTimelineEditError::Unsupported);
            }
        }

        let mut ordered_programs = programs
            .iter()
            .enumerate()
            .map(|(index, program)| (program.absolute_source_seconds.unwrap_or_default(), index))
            .collect::<Vec<_>>();
        ordered_programs.sort_by(|(left_anchor, left_index), (right_anchor, right_index)| {
            left_anchor
                .total_cmp(right_anchor)
                .then(left_index.cmp(right_index))
        });

        let mut authorized_wait_operation_ids = Vec::new();
        let mut edits = Vec::with_capacity(programs.len());
        let mut operation_ids = Vec::with_capacity(programs.len());
        let mut projected_duration = scene.duration;
        let mut resolved_offset = 0.0;
        for (source_seconds, program_index) in ordered_programs {
            let program = &programs[program_index];
            let expected_resolved_seconds = source_seconds + resolved_offset;
            if !studio_timeline_semantic_values_match(
                expected_resolved_seconds,
                program.resolved_seconds,
            ) {
                return Err(ApplyStudioTimelineEditError::Unsupported);
            }

            let operation = &program.operations[0];
            match operation {
                StudioTimelineOperation::InsertWait {
                    event_kind,
                    id,
                    interval,
                    purpose,
                    ..
                } => {
                    let duration = interval.end - interval.start;
                    if *event_kind != StudioTimelineEventKind::Wait
                        || *purpose != Some(StudioTimelinePurpose::SceneDuration)
                        || !studio_timeline_semantic_values_match(
                            interval.start,
                            program.resolved_seconds,
                        )
                        || !duration.is_finite()
                        || duration <= 0.0
                    {
                        return Err(ApplyStudioTimelineEditError::Unsupported);
                    }
                    edits.push(SceneTimelineEdit::InsertWait(SceneTimelineInsertion {
                        at: interval.start,
                        duration,
                    }));
                    authorized_wait_operation_ids.push(id.clone());
                    operation_ids.push(id.clone());
                    projected_duration += duration;
                    resolved_offset += duration;
                }
                StudioTimelineOperation::TrimSceneDuration {
                    id,
                    interval,
                    removed_duration,
                    target_duration,
                    wait_operation_ids,
                    ..
                } => {
                    if !studio_timeline_semantic_values_match(interval.start, interval.end)
                        || !studio_timeline_semantic_values_match(
                            interval.start,
                            program.resolved_seconds,
                        )
                        || wait_operation_ids.len() != authorized_wait_operation_ids.len()
                        || wait_operation_ids
                            .iter()
                            .zip(authorized_wait_operation_ids.iter().rev())
                            .any(|(actual, expected)| actual != expected)
                        || !removed_duration.is_finite()
                        || *removed_duration < 0.1 - TIMELINE_ANCHOR_EPSILON
                        || !target_duration.is_finite()
                        || *target_duration < 0.1
                    {
                        return Err(ApplyStudioTimelineEditError::Unsupported);
                    }
                    edits.push(SceneTimelineEdit::TrimSceneDuration {
                        at: interval.start,
                        removed_duration: *removed_duration,
                        target_duration: *target_duration,
                    });
                    operation_ids.push(id.clone());
                    projected_duration -= removed_duration;
                    resolved_offset -= *removed_duration;
                }
                StudioTimelineOperation::Unsupported { .. } => {
                    return Err(ApplyStudioTimelineEditError::Unsupported);
                }
            }
        }
        if !studio_duration_matches(projected_duration, evaluated_duration) {
            return Err(ApplyStudioTimelineEditError::Unsupported);
        }

        self.edit_scene_timeline(EditSceneTimelineCommand {
            edits,
            expected_base_revision,
            next_revision: next_revision.clone(),
            provenance: ProvenanceRecordV1 {
                evidence: operation_ids
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
                            insertion.at < wait.end - TIMELINE_ANCHOR_EPSILON
                                && insertion.at + insertion.duration
                                    > wait.start + TIMELINE_ANCHOR_EPSILON
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
    ) -> Result<SceneIrBundleV1, CreateSceneEntitiesError> {
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
        candidate.scene.provenance.push(command.provenance.clone());

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
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: command.next_revision,
        };

        let result = candidate.clone();
        self.replace_snapshot(candidate)?;
        Ok(result)
    }

    /// Authorizes complete normalized Studio creation Programs and applies one atomic batch.
    ///
    /// # Errors
    ///
    /// Returns `Unsupported` when the normalized Programs or their evaluated facts do not describe
    /// the supported create/position/fade plus instant transform subset. Every failure preserves
    /// the installed session.
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "exact normalized anchors are authority facts; keeping this closed state machine contiguous makes its admission rules auditable"
    )]
    pub fn apply_studio_creation_edit(
        &mut self,
        command: ApplyStudioCreationEditCommand,
    ) -> Result<SceneIrBundleV1, ApplyStudioCreationEditError> {
        let ApplyStudioCreationEditCommand {
            evaluated_duration,
            evaluated_entities,
            evaluated_events,
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
        if programs.is_empty()
            || !evaluated_duration.is_finite()
            || !studio_authoring_size_is_positive(frame)
            || !studio_authoring_size_is_positive(viewport)
            || frame.width != self.scene().camera.view.frame_width
            || frame.height != self.scene().camera.view.frame_height
            || programs.iter().any(|program| {
                !program.anchor_seconds.is_finite()
                    || !program.validation_valid
                    || !program.lowering_supported
                    || !studio_creation_program_is_closed(program)
            })
        {
            return Err(ApplyStudioCreationEditError::Unsupported);
        }

        let mut ordered_programs = (0..programs.len()).collect::<Vec<_>>();
        ordered_programs.sort_by(|left, right| {
            programs[*left]
                .anchor_seconds
                .total_cmp(&programs[*right].anchor_seconds)
                .then(left.cmp(right))
        });
        let create_programs = ordered_programs
            .iter()
            .copied()
            .filter(|index| {
                programs[*index].operations.iter().any(|operation| {
                    matches!(operation.kind, StudioCreationOperationKind::Create { .. })
                })
            })
            .collect::<Vec<_>>();
        if create_programs.is_empty() {
            return Err(ApplyStudioCreationEditError::Unsupported);
        }
        let followup_programs = ordered_programs
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
                    StudioCreationOperationKind::Create { .. } => operation.entity_id.is_some(),
                    StudioCreationOperationKind::Position { .. } => operation
                        .entity_id
                        .as_deref()
                        .is_none_or(|entity_id| !program_created_ids.contains(entity_id)),
                    StudioCreationOperationKind::FadeIn { persistent } => {
                        !persistent
                            || operation
                                .entity_id
                                .as_deref()
                                .is_none_or(|entity_id| !program_created_ids.contains(entity_id))
                    }
                    StudioCreationOperationKind::UniformScale { .. }
                    | StudioCreationOperationKind::Resize { .. }
                    | StudioCreationOperationKind::Unsupported => true,
                })
            {
                return Err(ApplyStudioCreationEditError::Unsupported);
            }
            for (operation_index, operation) in program.operations.iter().enumerate() {
                let StudioCreationOperationKind::Create { entity } = &operation.kind else {
                    continue;
                };
                if !created_ids.insert(entity.id.as_str())
                    || !matches!(
                        entity.kind,
                        StudioAuthoringEntityKind::Circle
                            | StudioAuthoringEntityKind::MathTex
                            | StudioAuthoringEntityKind::Rectangle
                    )
                {
                    return Err(ApplyStudioCreationEditError::Unsupported);
                }
                create_records.push((*program_index, operation_index));
            }
        }

        let mut pending = Vec::with_capacity(create_records.len());
        for (program_index, operation_index) in create_records {
            let program = &programs[program_index];
            let StudioCreationOperationKind::Create { entity: spec } =
                &program.operations[operation_index].kind
            else {
                unreachable!();
            };
            let evaluated_matches = evaluated_entities
                .iter()
                .enumerate()
                .filter(|(_, entity)| entity.object_graph_key == spec.id && entity.id == spec.id)
                .collect::<Vec<_>>();
            let [(evaluated_order, evaluated)] = evaluated_matches.as_slice() else {
                return Err(ApplyStudioCreationEditError::Unsupported);
            };
            let [lifetime] = evaluated.lifetimes.as_slice() else {
                return Err(ApplyStudioCreationEditError::Unsupported);
            };
            if evaluated.source_identity.is_some()
                || evaluated.transaction_id.as_deref() != Some(program.transaction_id.as_str())
                || evaluated.kind != spec.kind
                || !spec
                    .id
                    .starts_with(&format!("tx:{}/entity:", program.transaction_id))
                || !lifetime.start.is_finite()
                || !lifetime.end.is_finite()
                || lifetime.end <= lifetime.start
                || lifetime.start != spec.lifetime_start
            {
                return Err(ApplyStudioCreationEditError::Unsupported);
            }
            if spec.kind == StudioAuthoringEntityKind::MathTex {
                let Some(tex_parts) = spec.tex_parts.as_ref() else {
                    return Err(ApplyStudioCreationEditError::Unsupported);
                };
                if tex_parts.is_empty()
                    || tex_parts.iter().any(|part| part.trim().is_empty())
                    || evaluated.content_tex_parts.as_ref() != Some(tex_parts)
                    || evaluated
                        .content_sample_tex_parts
                        .iter()
                        .any(|sample| sample.as_ref() != Some(tex_parts))
                    || math_tex_outlines
                        .iter()
                        .filter(|outline| {
                            outline.entity_id == spec.id && outline.tex_parts == *tex_parts
                        })
                        .count()
                        != 1
                {
                    return Err(ApplyStudioCreationEditError::Unsupported);
                }
            }

            let positions = program
                .operations
                .iter()
                .filter_map(|operation| {
                    (operation.entity_id.as_deref() == Some(spec.id.as_str()))
                        .then_some(&operation.kind)
                })
                .filter_map(|kind| match kind {
                    StudioCreationOperationKind::Position {
                        position: Some(position),
                    } if studio_authoring_point_is_finite(position) => Some(position),
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
            if positions.len() != 1
                || fades.len() > 1
                || fades.first().is_some_and(|fade| {
                    fade.interval.start != lifetime.start
                        || !fade.interval.end.is_finite()
                        || fade.interval.end <= lifetime.start
                        || fade.interval.end > lifetime.end
                })
                || (spec.kind != StudioAuthoringEntityKind::MathTex
                    && studio_authoring_shape_size(spec.kind, spec.dimensions).is_none())
            {
                return Err(ApplyStudioCreationEditError::Unsupported);
            }
            pending.push((
                *evaluated_order,
                PendingStudioCreation {
                    current_dimensions: spec.dimensions,
                    fade_end: fades.first().map(|fade| fade.interval.end),
                    initial_dimensions: spec.dimensions,
                    initial_position: (*positions[0]).clone(),
                    instant_at: None,
                    kind: spec.kind,
                    lifetime: (*lifetime).clone(),
                    position: (*positions[0]).clone(),
                    scale: 1.0,
                    spec: spec.clone(),
                },
            ));
        }
        pending.sort_by_key(|(evaluated_order, _)| *evaluated_order);

        for program_index in followup_programs {
            let program = &programs[program_index];
            for operation_id in &program.schedule_order {
                let operation = program
                    .operations
                    .iter()
                    .find(|operation| operation.id == *operation_id)
                    .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                let entity_id = operation
                    .entity_id
                    .as_deref()
                    .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                let state = pending
                    .iter_mut()
                    .find(|(_, state)| state.spec.id == entity_id)
                    .map(|(_, state)| state)
                    .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                let instant_at = studio_creation_event_start(&evaluated_events, &operation.id)
                    .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                if state
                    .instant_at
                    .is_some_and(|prior| (prior - instant_at).abs() > 1e-9)
                {
                    return Err(ApplyStudioCreationEditError::Unsupported);
                }
                state.instant_at = Some(instant_at);
                match &operation.kind {
                    StudioCreationOperationKind::Position {
                        position: Some(position),
                    } if studio_authoring_point_is_finite(position) => {
                        state.position = position.clone();
                    }
                    StudioCreationOperationKind::UniformScale {
                        relative_factor: Some(relative_factor),
                    } if relative_factor.is_finite() && *relative_factor > 0.0 => {
                        state.scale *= relative_factor;
                    }
                    StudioCreationOperationKind::Resize {
                        shape,
                        to_dimensions,
                        to_position,
                    } if *shape == state.kind
                        && matches!(
                            shape,
                            StudioAuthoringEntityKind::Circle
                                | StudioAuthoringEntityKind::Rectangle
                        )
                        && studio_authoring_point_is_finite(to_position) =>
                    {
                        state.current_dimensions = *to_dimensions;
                        state.position = to_position.clone();
                    }
                    StudioCreationOperationKind::Create { .. }
                    | StudioCreationOperationKind::Position { .. }
                    | StudioCreationOperationKind::FadeIn { .. }
                    | StudioCreationOperationKind::UniformScale { .. }
                    | StudioCreationOperationKind::Resize { .. }
                    | StudioCreationOperationKind::Unsupported => {
                        return Err(ApplyStudioCreationEditError::Unsupported);
                    }
                }
            }
        }

        let timeline_insertions = create_programs
            .iter()
            .map(|program_index| {
                let program = &programs[*program_index];
                let end = program
                    .operations
                    .iter()
                    .filter(|operation| {
                        matches!(operation.kind, StudioCreationOperationKind::FadeIn { .. })
                    })
                    .map(|operation| operation.interval.end)
                    .fold(program.anchor_seconds, f64::max);
                SceneTimelineInsertion {
                    at: program.anchor_seconds,
                    duration: (end - program.anchor_seconds).max(0.0),
                }
            })
            .collect::<Vec<_>>();
        let inserted_duration = timeline_insertions
            .iter()
            .map(|insertion| insertion.duration)
            .sum::<f64>();
        if timeline_insertions.iter().any(|insertion| {
            !insertion.at.is_finite() || !insertion.duration.is_finite() || insertion.duration < 0.0
        }) || (self.scene().duration + inserted_duration - evaluated_duration).abs() > 1e-9
        {
            return Err(ApplyStudioCreationEditError::Unsupported);
        }

        let mut entities = Vec::with_capacity(pending.len());
        for (_, state) in pending {
            let geometry = match state.kind {
                StudioAuthoringEntityKind::Circle => {
                    let size = studio_authoring_shape_size(state.kind, state.initial_dimensions)
                        .ok_or(ApplyStudioCreationEditError::Unsupported)?;
                    CreateSceneEntityGeometry::Circle {
                        radius: size.width / 2.0,
                    }
                }
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
                    StudioAuthoringEntityKind::MathTex => (1.0, 1.0),
                    StudioAuthoringEntityKind::Image | StudioAuthoringEntityKind::Other => {
                        return Err(ApplyStudioCreationEditError::Unsupported);
                    }
                };
                if !state.scale.is_finite()
                    || state.scale <= 0.0
                    || !x_ratio.is_finite()
                    || x_ratio <= 0.0
                    || !y_ratio.is_finite()
                    || y_ratio <= 0.0
                {
                    return Err(ApplyStudioCreationEditError::Unsupported);
                }
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
            entities.push(CreateSceneEntity {
                fade_in: state.fade_end.map(|end| CreateSceneEntityFadeIn { end }),
                geometry,
                id: state.spec.id,
                instant_transform,
                lifetime: state.lifetime,
                position: studio_point_to_scene_point(
                    &state.initial_position,
                    frame,
                    viewport,
                    &self.scene().camera.view.center,
                ),
                scale: 1.0,
            });
        }

        let operation_count = programs
            .iter()
            .map(|program| program.operations.len())
            .sum::<usize>();
        self.create_scene_entities(CreateSceneEntitiesCommand {
            entities,
            expected_base_revision,
            next_revision: next_revision.clone(),
            provenance: ProvenanceRecordV1 {
                evidence: vec![format!(
                    "{} validated Studio Program(s) with {operation_count} operation(s) lowered as one atomic creation/transform core command",
                    programs.len()
                )],
                id: format!("studio-create:{next_revision}"),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
            timeline_insertions,
        })
        .map_err(Into::into)
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
            base_studio_scene_id,
            candidates,
            evaluated_duration,
            evaluated_scene_id,
            expected_base_revision,
            frame,
            next_revision,
            programs,
            viewport,
        } = command;
        let scene = self.scene();
        if base_studio_scene_id != evaluated_scene_id
            || !studio_duration_matches(scene.duration, evaluated_duration)
            || !studio_authoring_size_is_positive(frame)
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

    /// Authorizes one complete normalized Studio motion Program and applies it atomically.
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
        reason = "the Studio anchor and operation start are one normalized authority fact"
    )]
    pub fn apply_studio_motion_edit(
        &mut self,
        command: ApplyStudioMotionEditCommand,
    ) -> Result<SceneIrBundleV1, ApplyStudioMotionEditError> {
        let ApplyStudioMotionEditCommand {
            base_studio_scene_id,
            evaluated_duration,
            evaluated_scene_id,
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
            || base_studio_scene_id != evaluated_scene_id
            || !studio_authoring_size_is_positive(frame)
            || !studio_authoring_size_is_positive(viewport)
            || frame.width != scene.camera.view.frame_width
            || frame.height != scene.camera.view.frame_height
            || programs.len() != 1
        {
            return Err(ApplyStudioMotionEditError::Unsupported);
        }

        let program = &programs[0];
        let operation = program
            .operations
            .first()
            .filter(|operation| {
                program.validation_valid
                    && program.lowering_supported
                    && studio_motion_program_is_closed(program)
                    && !operation.id().is_empty()
                    && program.anchor_seconds == operation.interval().start
                    && program.origin == operation.origin()
            })
            .ok_or(ApplyStudioMotionEditError::Unsupported)?;
        let StudioMotionOperation::CreateMotion {
            control_offset,
            delta,
            easing,
            id,
            interval,
            target_entity_ids,
            ..
        } = operation
        else {
            return Err(ApplyStudioMotionEditError::Unsupported);
        };
        if !studio_duration_matches(
            scene.duration + interval.end - interval.start,
            evaluated_duration,
        ) {
            return Err(ApplyStudioMotionEditError::Unsupported);
        }

        let mut runtime_entity_ids = Vec::with_capacity(target_entity_ids.len());
        for studio_entity_id in target_entity_ids {
            let mut matching_entities = studio_entities
                .iter()
                .filter(|entity| entity.object_graph_key == *studio_entity_id);
            let entity = matching_entities
                .next()
                .filter(|entity| !entity.provisional && entity.source_identity.is_some())
                .ok_or(ApplyStudioMotionEditError::Unsupported)?;
            if matching_entities.next().is_some() {
                return Err(ApplyStudioMotionEditError::Unsupported);
            }
            let source_identity = entity
                .source_identity
                .as_deref()
                .ok_or(ApplyStudioMotionEditError::Unsupported)?;
            let mut matching_bindings = source_runtime_bindings
                .iter()
                .filter(|binding| binding.source_identity_key == source_identity);
            let binding = matching_bindings
                .next()
                .filter(|binding| binding.source_name == source_identity)
                .ok_or(ApplyStudioMotionEditError::Unsupported)?;
            if matching_bindings.next().is_some() {
                return Err(ApplyStudioMotionEditError::Unsupported);
            }
            runtime_entity_ids.push(binding.runtime_entity_id.clone());
        }

        self.create_scene_motion(CreateSceneMotionCommand {
            control_offset: studio_vector_to_scene_vector(control_offset, frame, viewport),
            delta: studio_vector_to_scene_vector(delta, frame, viewport),
            easing: *easing,
            expected_base_revision,
            interval: interval.clone(),
            next_revision: next_revision.clone(),
            provenance: ProvenanceRecordV1 {
                evidence: vec![format!("authorized operation {id}")],
                id: format!("studio-motion:{next_revision}"),
                origin: ProvenanceOriginV1::StudioEditProgram,
            },
            target_entity_ids: runtime_entity_ids,
        })
    }

    /// Atomically adds one quadratic world-space motion to one or more root entities.
    fn create_scene_motion(
        &mut self,
        command: CreateSceneMotionCommand,
    ) -> Result<SceneIrBundleV1, ApplyStudioMotionEditError> {
        let scene = self.scene();
        let target_starts = validate_create_scene_motion_command(scene, &command)?;

        let easing = match command.easing {
            StudioMotionEasing::Linear => EasingV1::Linear {},
            StudioMotionEasing::Smooth => EasingV1::ManimSmooth {},
        };
        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: scene.clone(),
        };
        insert_scene_time(
            &mut candidate.scene,
            &SceneTimelineInsertion {
                at: command.interval.start,
                duration: command.interval.end - command.interval.start,
            },
        );
        for (entity_id, start) in target_starts {
            let channel_id = unused_channel_id(&candidate.scene, "studio-motion");
            candidate
                .scene
                .animation_channels
                .push(AnimationChannelV1::MotionPath {
                    entity_id,
                    id: channel_id,
                    keyframes: vec![
                        KeyframeV1 {
                            at: command.interval.start,
                            easing_to_next: Some(easing.clone()),
                            value: 0.0,
                        },
                        KeyframeV1 {
                            at: command.interval.end,
                            easing_to_next: None,
                            value: 1.0,
                        },
                    ],
                    orient_to_path: false,
                    parameterization: Some(
                        MotionPathParameterizationV1::ManimPointFromProportionV1,
                    ),
                    path: quadratic_motion_path(start, &command.delta, &command.control_offset),
                    provenance_id: command.provenance.id.clone(),
                });
        }
        let mut capabilities = candidate
            .scene
            .required_capabilities
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        capabilities.insert(SceneCapabilityV1::MotionPathAnimation);
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

    /// Applies the closed static imported-root subset of one or two Studio edit operations.
    ///
    /// The caller serializes every Program operation, including unsupported ones. This method is
    /// therefore the sole authority for operation admission, identity resolution, geometry
    /// baseline verification, and atomic mutation.
    ///
    /// # Errors
    ///
    /// Returns `Unsupported` when the complete normalized edit is outside the closed subset, or
    /// the existing transform error when the installed Scene rejects the resolved intent.
    #[allow(
        clippy::float_cmp,
        clippy::too_many_lines,
        reason = "exact t=0 and identity factors define the closed authoring subset; keeping its one admission path contiguous prevents split authority"
    )]
    pub fn apply_static_root_transform_edit(
        &mut self,
        command: ApplyStaticRootTransformEditCommand,
    ) -> Result<SceneIrBundleV1, ApplyStaticRootTransformEditError> {
        let ApplyStaticRootTransformEditCommand {
            expected_base_revision,
            frame,
            next_revision,
            operations,
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
            || operations.is_empty()
            || operations.len() > 2
        {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        }

        let mut entity_id: Option<String> = None;
        let mut operation_ids = Vec::new();
        let mut position: Option<PointV1> = None;
        let mut uniform_scale: Option<f64> = None;
        let mut resize: Option<(
            StaticRootTransformEntityKind,
            StaticRootTransformDimensions,
            PointV1,
            f64,
            StaticRootTransformDimensions,
            PointV1,
        )> = None;
        for operation in operations {
            if operation.anchor_seconds != 0.0
                || !operation.lowering_supported
                || !operation.validation_valid
                || operation.interval.start != 0.0
                || operation.interval.end != 0.0
                || operation.origin != operation.program_origin
                || operation.id.is_empty()
                || operation_ids.contains(&operation.id)
                || entity_id
                    .as_ref()
                    .is_some_and(|expected| expected != &operation.entity_id)
            {
                return Err(ApplyStaticRootTransformEditError::Unsupported);
            }
            operation_ids.push(operation.id.clone());
            entity_id.get_or_insert_with(|| operation.entity_id.clone());
            match operation.kind {
                StaticRootTransformOperationKind::Position {
                    position: Some(target),
                } if matches!(
                    operation.origin,
                    StaticRootTransformOrigin::DirectManipulation
                        | StaticRootTransformOrigin::StudioDefault
                ) && studio_authoring_point_is_finite(&target)
                    && position.replace(target.clone()).is_none() => {}
                StaticRootTransformOperationKind::UniformScale {
                    control_present,
                    from: Some(from),
                    relative_factor: Some(factor),
                    to: Some(to),
                } if operation.origin == StaticRootTransformOrigin::DirectManipulation
                    && !control_present
                    && factor.is_finite()
                    && factor > 0.0
                    && factor != 1.0
                    && from.is_finite()
                    && from > 0.0
                    && to.is_finite()
                    && to > 0.0
                    && close_transform_baseline_value(to / from, factor)
                    && uniform_scale.replace(factor).is_none() => {}
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
                    shape,
                    StaticRootTransformEntityKind::Circle
                        | StaticRootTransformEntityKind::Rectangle
                ) && from_scale.is_finite()
                    && from_scale > 0.0
                    && studio_authoring_point_is_finite(&from_position)
                    && studio_authoring_point_is_finite(&to_position)
                    && resize
                        .replace((
                            shape,
                            from_dimensions,
                            from_position.clone(),
                            from_scale,
                            to_dimensions,
                            to_position.clone(),
                        ))
                        .is_none() => {}
                StaticRootTransformOperationKind::Position { .. }
                | StaticRootTransformOperationKind::UniformScale { .. }
                | StaticRootTransformOperationKind::Resize { .. }
                | StaticRootTransformOperationKind::Unsupported => {
                    return Err(ApplyStaticRootTransformEditError::Unsupported);
                }
            }
        }
        if (resize.is_some()
            && (position.is_some() || uniform_scale.is_some() || operation_ids.len() != 1))
            || (resize.is_none() && position.is_none() && uniform_scale.is_none())
        {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        }

        let entity_id = entity_id.ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
        let mut matching_studio_entities = studio_entities
            .iter()
            .filter(|entity| entity.object_graph_key == entity_id && entity.id == entity_id);
        let studio_entity = matching_studio_entities
            .next()
            .filter(|entity| {
                !entity.provisional
                    && entity.transaction_id.is_none()
                    && entity.source_identity.is_some()
            })
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
        if matching_studio_entities.next().is_some()
            || !matches!(
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
            || resize
                .as_ref()
                .is_some_and(|(shape, ..)| *shape != studio_entity.kind)
        {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        }
        let source_identity = studio_entity
            .source_identity
            .as_deref()
            .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
        let mut matching_bindings = source_runtime_bindings
            .iter()
            .filter(|binding| binding.source_identity_key == source_identity);
        let binding = matching_bindings
            .next()
            .filter(|binding| binding.source_name == source_identity)
            .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;
        if matching_bindings.next().is_some()
            || source_runtime_bindings
                .iter()
                .filter(|candidate| candidate.runtime_entity_id == binding.runtime_entity_id)
                .count()
                != 1
        {
            return Err(ApplyStaticRootTransformEditError::Unsupported);
        }
        let runtime_entity = scene
            .entities
            .iter()
            .find(|entity| entity.id == binding.runtime_entity_id)
            .filter(|entity| {
                entity.parent_id.is_none()
                    && static_transform_geometry_matches(studio_entity.kind, entity)
            })
            .ok_or(ApplyStaticRootTransformEditError::Unsupported)?;

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
            let target =
                studio_point_to_scene_point(&target, frame, viewport, &scene.camera.view.center);
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
                    studio_point_to_scene_point(&target, frame, viewport, &scene.camera.view.center)
                }),
            }
        };
        let mut evidence = vec!["Studio static imported-root edit".to_owned()];
        evidence.extend(
            operation_ids
                .into_iter()
                .map(|operation_id| format!("authorized operation {operation_id}")),
        );
        let provenance = ProvenanceRecordV1 {
            evidence,
            id: format!("studio-static-transform:{next_revision}"),
            origin: ProvenanceOriginV1::StudioEditProgram,
        };
        let runtime_entity_id = runtime_entity.id.clone();
        self.transform_scene_entity(TransformSceneEntityCommand {
            entity_id: runtime_entity_id,
            expected_base_revision,
            intent,
            next_revision,
            provenance,
        })
        .map_err(Into::into)
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
        bundle.scene.required_capabilities = vec![SceneCapabilityV1::ShapePrimitives];
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

    fn static_root_position_command() -> ApplyStaticRootTransformEditCommand {
        ApplyStaticRootTransformEditCommand {
            expected_base_revision: BASE_REVISION.to_owned(),
            frame: StaticRootTransformSize {
                height: 9.0,
                width: 16.0,
            },
            next_revision: NEXT_REVISION.to_owned(),
            operations: vec![StaticRootTransformOperation {
                anchor_seconds: 0.0,
                entity_id: "source:circle".to_owned(),
                id: "move-circle".to_owned(),
                interval: IntervalV1 {
                    end: 0.0,
                    start: 0.0,
                },
                kind: StaticRootTransformOperationKind::Position {
                    position: Some(PointV1 { x: 400.0, y: 180.0 }),
                },
                lowering_supported: true,
                origin: StaticRootTransformOrigin::DirectManipulation,
                program_origin: StaticRootTransformOrigin::DirectManipulation,
                validation_valid: true,
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
            base_studio_scene_id: "scene.py#CircleScene".to_owned(),
            evaluated_duration: bundle.scene.duration + 1.0,
            evaluated_scene_id: "scene.py#CircleScene".to_owned(),
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            frame: StudioAuthoringSize {
                height: 9.0,
                width: 16.0,
            },
            next_revision: NEXT_REVISION.to_owned(),
            programs: vec![StudioMotionProgram {
                anchor_seconds: 0.5,
                lowering_supported: true,
                operations: vec![StudioMotionOperation::CreateMotion {
                    control_offset: PointV1 { x: 0.0, y: -160.0 },
                    delta: PointV1 { x: 240.0, y: -80.0 },
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
                schedule_order: vec!["create-motion".to_owned()],
                validation_valid: true,
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
            base_studio_scene_id: "scene.py#BoundScene".to_owned(),
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
            evaluated_duration: bundle.scene.duration,
            evaluated_scene_id: "scene.py#BoundScene".to_owned(),
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
                validation_valid: true,
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
            next_revision: NEXT_REVISION.to_owned(),
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
            end: 1.25,
            start: 1.25,
        };
        ApplyStudioCreationEditCommand {
            evaluated_duration: bundle.scene.duration + 0.4,
            evaluated_entities: vec![StudioCreationEvaluatedEntity {
                content_sample_tex_parts: vec![],
                content_tex_parts: None,
                id: entity_id.to_owned(),
                kind: StudioAuthoringEntityKind::Circle,
                lifetimes: vec![IntervalV1 {
                    end: bundle.scene.duration + 0.4,
                    start: 0.5,
                }],
                object_graph_key: entity_id.to_owned(),
                source_identity: None,
                transaction_id: Some("create".to_owned()),
            }],
            evaluated_events: vec![StudioCreationEvaluatedEvent {
                interval: Some(resize_interval.clone()),
                operation_id: Some("resize".to_owned()),
            }],
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            frame: StudioAuthoringSize {
                height: bundle.scene.camera.view.frame_height,
                width: bundle.scene.camera.view.frame_width,
            },
            math_tex_outlines: vec![],
            next_revision: NEXT_REVISION.to_owned(),
            programs: vec![
                StudioCreationProgram {
                    anchor_seconds: 0.5,
                    lowering_supported: true,
                    operations: vec![
                        StudioCreationOperation {
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
                                    lifetime_start: 0.5,
                                    tex_parts: None,
                                },
                            },
                        },
                        StudioCreationOperation {
                            entity_id: Some(entity_id.to_owned()),
                            id: "position".to_owned(),
                            interval: create_interval,
                            kind: StudioCreationOperationKind::Position {
                                position: Some(PointV1 { x: 320.0, y: 180.0 }),
                            },
                        },
                        StudioCreationOperation {
                            entity_id: Some(entity_id.to_owned()),
                            id: "fade".to_owned(),
                            interval: IntervalV1 {
                                end: 0.9,
                                start: 0.5,
                            },
                            kind: StudioCreationOperationKind::FadeIn { persistent: true },
                        },
                    ],
                    schedule_order: vec![
                        "create".to_owned(),
                        "position".to_owned(),
                        "fade".to_owned(),
                    ],
                    transaction_id: "create".to_owned(),
                    validation_valid: true,
                },
                StudioCreationProgram {
                    anchor_seconds: 1.25,
                    lowering_supported: true,
                    operations: vec![StudioCreationOperation {
                        entity_id: Some(entity_id.to_owned()),
                        id: "resize".to_owned(),
                        interval: resize_interval,
                        kind: StudioCreationOperationKind::Resize {
                            shape: StudioAuthoringEntityKind::Circle,
                            to_dimensions: StudioAuthoringDimensions {
                                height: None,
                                radius: Some(2.0),
                                width: None,
                            },
                            to_position: PointV1 { x: 360.0, y: 180.0 },
                        },
                    }],
                    schedule_order: vec!["resize".to_owned()],
                    transaction_id: "resize".to_owned(),
                    validation_valid: true,
                },
            ],
            viewport: StudioAuthoringSize {
                height: 360.0,
                width: 640.0,
            },
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
        resolved_seconds: f64,
        duration: f64,
    ) -> StudioTimelineProgram {
        StudioTimelineProgram {
            absolute_source_seconds: Some(source_seconds),
            lowering_supported: true,
            operations: vec![StudioTimelineOperation::InsertWait {
                event_kind: StudioTimelineEventKind::Wait,
                id: id.to_owned(),
                interval: IntervalV1 {
                    end: resolved_seconds + duration,
                    start: resolved_seconds,
                },
                origin: StudioAuthoringOrigin::StudioDefault,
                purpose: Some(StudioTimelinePurpose::SceneDuration),
            }],
            origin: StudioAuthoringOrigin::StudioDefault,
            resolved_seconds,
            schedule_order: vec![id.to_owned()],
            validation_valid: true,
        }
    }

    fn studio_timeline_trim_program(
        id: &str,
        source_seconds: f64,
        resolved_seconds: f64,
        removed_duration: f64,
        target_duration: f64,
        wait_operation_ids: Vec<String>,
    ) -> StudioTimelineProgram {
        StudioTimelineProgram {
            absolute_source_seconds: Some(source_seconds),
            lowering_supported: true,
            operations: vec![StudioTimelineOperation::TrimSceneDuration {
                id: id.to_owned(),
                interval: IntervalV1 {
                    end: resolved_seconds,
                    start: resolved_seconds,
                },
                origin: StudioAuthoringOrigin::StudioDefault,
                removed_duration,
                target_duration,
                wait_operation_ids,
            }],
            origin: StudioAuthoringOrigin::StudioDefault,
            resolved_seconds,
            schedule_order: vec![id.to_owned()],
            validation_valid: true,
        }
    }

    fn studio_timeline_command(bundle: &SceneIrBundleV1) -> ApplyStudioTimelineEditCommand {
        let source_seconds = 0.5;
        ApplyStudioTimelineEditCommand {
            base_studio_scene_id: "studio-scene".to_owned(),
            evaluated_duration: bundle.scene.duration + 1.5,
            evaluated_scene_id: "studio-scene".to_owned(),
            expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
            next_revision: NEXT_REVISION.to_owned(),
            programs: vec![
                studio_timeline_wait_program("wait-1", source_seconds, source_seconds, 1.0),
                studio_timeline_trim_program(
                    "trim-1",
                    source_seconds,
                    source_seconds + 1.0,
                    0.5,
                    bundle.scene.duration + 0.5,
                    vec!["wait-1".to_owned()],
                ),
                studio_timeline_wait_program("wait-2", source_seconds, source_seconds + 0.5, 1.0),
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
    }

    #[test]
    fn applies_one_normalized_circle_resize_from_the_installed_geometry_baseline() {
        let mut command = static_root_position_command();
        command.operations[0].kind = StaticRootTransformOperationKind::Resize {
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
        command.operations[0].entity_id = "source:formula".to_owned();
        let mut scale = command.operations[0].clone();
        scale.id = "scale-formula".to_owned();
        scale.kind = StaticRootTransformOperationKind::UniformScale {
            control_present: false,
            from: Some(1.0),
            relative_factor: Some(1.5),
            to: Some(1.5),
        };
        command.operations.push(scale);
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
            scale: None,
            source_identity: Some("formula".to_owned()),
            transaction_id: None,
        }];
        let mut session = EngineSessionV1::new(bundle).unwrap();

        let result = session.apply_static_root_transform_edit(command).unwrap();
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
    fn rejects_any_unsupported_normalized_operation_without_mutating_the_session() {
        let bundle = static_imported_bundle();
        let expected_scene = bundle.scene.clone();
        let mut command = static_root_position_command();
        command.operations[0].kind = StaticRootTransformOperationKind::Unsupported;
        let mut session = EngineSessionV1::new(bundle).unwrap();

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
        command.evaluated_entities[0].kind = StudioAuthoringEntityKind::MathTex;
        command.evaluated_entities[0].content_tex_parts = Some(tex_parts.clone());
        command.programs[1].operations[0].kind = StudioCreationOperationKind::UniformScale {
            relative_factor: Some(1.5),
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
    fn normalized_creation_rejects_hidden_operations_and_mismatched_identity_atomically() {
        let bundle = static_imported_bundle();
        let mut unsupported = studio_creation_command(&bundle);
        unsupported.programs[1].operations[0].kind = StudioCreationOperationKind::Unsupported;
        let mut mismatched_identity = studio_creation_command(&bundle);
        mismatched_identity.evaluated_entities[0].transaction_id = Some("foreign".to_owned());

        for command in [unsupported, mismatched_identity] {
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
        let command = studio_timeline_command(&bundle);
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
    fn studio_timeline_authority_rejects_invalid_normalized_facts_atomically() {
        let bundle = static_imported_bundle();
        let mut cases = Vec::new();

        let mut command = studio_timeline_command(&bundle);
        command.programs[0].resolved_seconds += 0.0001;
        cases.push(("resolved anchor", command));

        let mut command = studio_timeline_command(&bundle);
        command.programs[0].absolute_source_seconds = Some(-0.5);
        cases.push(("negative source anchor", command));

        let mut command = studio_timeline_command(&bundle);
        command.programs[0].validation_valid = false;
        cases.push(("invalid validation", command));

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
        let interval = match &command.programs[2].operations[0] {
            StudioTimelineOperation::InsertWait { interval, .. } => interval.clone(),
            _ => unreachable!(),
        };
        command.programs[2].operations[0] = StudioTimelineOperation::Unsupported {
            id: "wait-2".to_owned(),
            interval,
            origin: StudioAuthoringOrigin::StudioDefault,
        };
        cases.push(("mixed operation", command));

        let mut command = studio_timeline_command(&bundle);
        command.evaluated_scene_id = "other-scene".to_owned();
        cases.push(("evaluated Scene identity", command));

        let mut command = studio_timeline_command(&bundle);
        command.evaluated_duration += 0.01;
        cases.push(("evaluated duration", command));

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
    fn overlapping_wait_insertion_is_rejected_atomically() {
        let mut session = EngineSessionV1::new(timeline_bundle()).unwrap();
        let command = timeline_command(vec![
            SceneTimelineEdit::InsertWait(SceneTimelineInsertion {
                at: 7.0,
                duration: 1.0,
            }),
            SceneTimelineEdit::InsertWait(SceneTimelineInsertion {
                at: 7.5,
                duration: 1.0,
            }),
            SceneTimelineEdit::TrimSceneDuration {
                at: 8.5,
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
    fn rejected_studio_motion_facts_preserve_the_retained_scene() {
        let bundle = static_imported_bundle();
        let mut rejected = Vec::new();

        let mut wrong_scene = studio_motion_edit_command(&bundle);
        wrong_scene.evaluated_scene_id = "scene.py#OtherScene".to_owned();
        rejected.push(wrong_scene);

        let mut wrong_duration = studio_motion_edit_command(&bundle);
        wrong_duration.evaluated_duration += 0.001;
        rejected.push(wrong_duration);

        let mut mixed = studio_motion_edit_command(&bundle);
        mixed.programs[0]
            .operations
            .push(StudioMotionOperation::Unsupported {
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
}
