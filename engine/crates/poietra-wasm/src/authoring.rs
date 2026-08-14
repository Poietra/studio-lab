use poietra_eval::{
    ApplyStaticRootTransformEditCommand, ApplyStaticRootTransformEditError,
    ApplyStudioCreationEditCommand, ApplyStudioCreationEditError, CreateSceneMotionCommand,
    CreateSceneMotionEasing, CreateSceneMotionError, EditSceneTimelineCommand,
    EditSceneTimelineError, EngineSessionV1, EvaluationError, RotateSceneEntityCommand,
    RotateSceneEntityError, ScaleAboutPivot, SceneEntityAxisFactors, SceneTimelineEdit,
    SceneTimelineInsertion, SetSubtreeVectorPaintAlphaCommand, SetSubtreeVectorPaintAlphaError,
    StaticRootTransformOperation, StaticRootTransformSize, StaticRootTransformSourceBinding,
    StaticRootTransformStudioEntity, StudioAuthoringSize, StudioCreationEvaluatedEntity,
    StudioCreationEvaluatedEvent, StudioCreationMathTexOutline, StudioCreationProgram,
    TransformSceneEntityAtTimeCommand, TransformSceneEntityCommand, TransformSceneEntityError,
    TransformSceneEntityExpectedBaseline, TransformSceneEntityIntent,
};
use poietra_scene_ir::{
    ContractJsonError, ContractVersionV1, IntervalV1, PointV1, ProvenanceRecordV1, SceneIrBundleV1,
    parse_scene_ir_bundle_json_v1,
};
use serde::{Deserialize, de::DeserializeOwned};
use wasm_bindgen::prelude::*;

const MAX_SCENE_AUTHORING_COMMAND_JSON_BYTES_V1: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Deserialize)]
enum TransformSceneEntitySchemaV1 {
    #[serde(rename = "poietra.transform-scene-entity")]
    TransformSceneEntity,
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum TransformSceneEntityAtTimeSchemaV1 {
    #[serde(rename = "poietra.transform-scene-entity-at-time")]
    TransformSceneEntityAtTime,
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum ApplyStaticRootTransformEditSchemaV1 {
    #[serde(rename = "poietra.apply-static-root-transform-edit")]
    ApplyStaticRootTransformEdit,
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum ApplyStudioCreationEditSchemaV1 {
    #[serde(rename = "poietra.apply-studio-creation-edit")]
    ApplyStudioCreationEdit,
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum CreateSceneMotionSchemaV1 {
    #[serde(rename = "poietra.create-scene-motion")]
    CreateSceneMotion,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum CreateSceneMotionEasingJsonV1 {
    Linear,
    Smooth,
}

impl From<CreateSceneMotionEasingJsonV1> for CreateSceneMotionEasing {
    fn from(value: CreateSceneMotionEasingJsonV1) -> Self {
        match value {
            CreateSceneMotionEasingJsonV1::Linear => Self::Linear,
            CreateSceneMotionEasingJsonV1::Smooth => Self::Smooth,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateSceneMotionCommandJsonV1 {
    control_offset: PointV1,
    delta: PointV1,
    easing: CreateSceneMotionEasingJsonV1,
    expected_base_revision: String,
    interval: IntervalV1,
    next_revision: String,
    provenance: ProvenanceRecordV1,
    #[serde(rename = "schema")]
    _schema: CreateSceneMotionSchemaV1,
    target_entity_ids: Vec<String>,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
}

impl From<CreateSceneMotionCommandJsonV1> for CreateSceneMotionCommand {
    fn from(value: CreateSceneMotionCommandJsonV1) -> Self {
        Self {
            control_offset: value.control_offset,
            delta: value.delta,
            easing: value.easing.into(),
            expected_base_revision: value.expected_base_revision,
            interval: value.interval,
            next_revision: value.next_revision,
            provenance: value.provenance,
            target_entity_ids: value.target_entity_ids,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum EditSceneTimelineSchemaV1 {
    #[serde(rename = "poietra.edit-scene-timeline")]
    EditSceneTimeline,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum SceneTimelineEditJsonV1 {
    #[serde(rename = "insert-wait")]
    InsertWait { at: f64, duration: f64 },
    #[serde(rename = "trim-scene-duration")]
    TrimSceneDuration {
        at: f64,
        #[serde(rename = "removedDuration")]
        removed_duration: f64,
        #[serde(rename = "targetDuration")]
        target_duration: f64,
    },
}

impl From<SceneTimelineEditJsonV1> for SceneTimelineEdit {
    fn from(value: SceneTimelineEditJsonV1) -> Self {
        match value {
            SceneTimelineEditJsonV1::InsertWait { at, duration } => {
                Self::InsertWait(SceneTimelineInsertion { at, duration })
            }
            SceneTimelineEditJsonV1::TrimSceneDuration {
                at,
                removed_duration,
                target_duration,
            } => Self::TrimSceneDuration {
                at,
                removed_duration,
                target_duration,
            },
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EditSceneTimelineCommandJsonV1 {
    edits: Vec<SceneTimelineEditJsonV1>,
    expected_base_revision: String,
    next_revision: String,
    provenance: ProvenanceRecordV1,
    #[serde(rename = "schema")]
    _schema: EditSceneTimelineSchemaV1,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
}

impl From<EditSceneTimelineCommandJsonV1> for EditSceneTimelineCommand {
    fn from(value: EditSceneTimelineCommandJsonV1) -> Self {
        Self {
            edits: value.edits.into_iter().map(Into::into).collect(),
            expected_base_revision: value.expected_base_revision,
            next_revision: value.next_revision,
            provenance: value.provenance,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum SetSubtreeVectorPaintAlphaSchemaV1 {
    #[serde(rename = "poietra.set-subtree-vector-paint-alpha")]
    SetSubtreeVectorPaintAlpha,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetSubtreeVectorPaintAlphaCommandJsonV1 {
    alpha: f64,
    expected_base_revision: String,
    next_revision: String,
    provenance: ProvenanceRecordV1,
    root_entity_id: String,
    #[serde(rename = "schema")]
    _schema: SetSubtreeVectorPaintAlphaSchemaV1,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
}

impl From<SetSubtreeVectorPaintAlphaCommandJsonV1> for SetSubtreeVectorPaintAlphaCommand {
    fn from(value: SetSubtreeVectorPaintAlphaCommandJsonV1) -> Self {
        Self {
            alpha: value.alpha,
            expected_base_revision: value.expected_base_revision,
            next_revision: value.next_revision,
            provenance: value.provenance,
            root_entity_id: value.root_entity_id,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScaleAboutPivotJsonV1 {
    pivot: PointV1,
    x_factor: f64,
    y_factor: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SceneEntityAxisFactorsJsonV1 {
    x_factor: f64,
    y_factor: f64,
}

impl From<SceneEntityAxisFactorsJsonV1> for SceneEntityAxisFactors {
    fn from(value: SceneEntityAxisFactorsJsonV1) -> Self {
        Self {
            x_factor: value.x_factor,
            y_factor: value.y_factor,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum TransformSceneEntityExpectedBaselineJsonV1 {
    CurrentCenter,
    CurrentUniformAffine,
    WorldSize {
        height: f64,
        width: f64,
        world_center: PointV1,
    },
}

impl From<TransformSceneEntityExpectedBaselineJsonV1> for TransformSceneEntityExpectedBaseline {
    fn from(value: TransformSceneEntityExpectedBaselineJsonV1) -> Self {
        match value {
            TransformSceneEntityExpectedBaselineJsonV1::CurrentCenter => Self::CurrentCenter,
            TransformSceneEntityExpectedBaselineJsonV1::CurrentUniformAffine => {
                Self::CurrentUniformAffine
            }
            TransformSceneEntityExpectedBaselineJsonV1::WorldSize {
                height,
                width,
                world_center,
            } => Self::WorldSize {
                height,
                width,
                world_center,
            },
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum TransformSceneEntityIntentJsonV1 {
    Relative {
        delta: PointV1,
        scale: Option<ScaleAboutPivotJsonV1>,
    },
    FromBaseline {
        baseline: TransformSceneEntityExpectedBaselineJsonV1,
        scale: Option<SceneEntityAxisFactorsJsonV1>,
        target_center: Option<PointV1>,
    },
}

impl From<TransformSceneEntityIntentJsonV1> for TransformSceneEntityIntent {
    fn from(value: TransformSceneEntityIntentJsonV1) -> Self {
        match value {
            TransformSceneEntityIntentJsonV1::Relative { delta, scale } => Self::Relative {
                delta,
                scale: scale.map(Into::into),
            },
            TransformSceneEntityIntentJsonV1::FromBaseline {
                baseline,
                scale,
                target_center,
            } => Self::FromBaseline {
                expected_baseline: baseline.into(),
                scale: scale.map(Into::into),
                target_center,
            },
        }
    }
}

impl From<ScaleAboutPivotJsonV1> for ScaleAboutPivot {
    fn from(value: ScaleAboutPivotJsonV1) -> Self {
        Self {
            pivot: value.pivot,
            x_factor: value.x_factor,
            y_factor: value.y_factor,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransformSceneEntityCommandJsonV1 {
    entity_id: String,
    expected_base_revision: String,
    intent: TransformSceneEntityIntentJsonV1,
    next_revision: String,
    provenance: ProvenanceRecordV1,
    #[serde(rename = "schema")]
    _schema: TransformSceneEntitySchemaV1,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
}

impl From<TransformSceneEntityCommandJsonV1> for TransformSceneEntityCommand {
    fn from(value: TransformSceneEntityCommandJsonV1) -> Self {
        Self {
            entity_id: value.entity_id,
            expected_base_revision: value.expected_base_revision,
            intent: value.intent.into(),
            next_revision: value.next_revision,
            provenance: value.provenance,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransformSceneEntityAtTimeCommandJsonV1 {
    at: f64,
    delta: PointV1,
    entity_id: String,
    expected_base_revision: String,
    next_revision: String,
    provenance: ProvenanceRecordV1,
    #[serde(rename = "schema")]
    _schema: TransformSceneEntityAtTimeSchemaV1,
    scale: Option<ScaleAboutPivotJsonV1>,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
}

impl From<TransformSceneEntityAtTimeCommandJsonV1> for TransformSceneEntityAtTimeCommand {
    fn from(value: TransformSceneEntityAtTimeCommandJsonV1) -> Self {
        Self {
            at: value.at,
            delta: value.delta,
            entity_id: value.entity_id,
            expected_base_revision: value.expected_base_revision,
            next_revision: value.next_revision,
            provenance: value.provenance,
            scale: value.scale.map(Into::into),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyStaticRootTransformEditCommandJsonV1 {
    expected_base_revision: String,
    frame: StaticRootTransformSize,
    next_revision: String,
    operations: Vec<StaticRootTransformOperation>,
    #[serde(rename = "schema")]
    _schema: ApplyStaticRootTransformEditSchemaV1,
    source_runtime_bindings: Vec<StaticRootTransformSourceBinding>,
    studio_entities: Vec<StaticRootTransformStudioEntity>,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
    viewport: StaticRootTransformSize,
}

impl From<ApplyStaticRootTransformEditCommandJsonV1> for ApplyStaticRootTransformEditCommand {
    fn from(value: ApplyStaticRootTransformEditCommandJsonV1) -> Self {
        Self {
            expected_base_revision: value.expected_base_revision,
            frame: value.frame,
            next_revision: value.next_revision,
            operations: value.operations,
            source_runtime_bindings: value.source_runtime_bindings,
            studio_entities: value.studio_entities,
            viewport: value.viewport,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyStudioCreationEditCommandJsonV1 {
    evaluated_duration: f64,
    evaluated_entities: Vec<StudioCreationEvaluatedEntity>,
    evaluated_events: Vec<StudioCreationEvaluatedEvent>,
    expected_base_revision: String,
    frame: StudioAuthoringSize,
    math_tex_outlines: Vec<StudioCreationMathTexOutline>,
    next_revision: String,
    programs: Vec<StudioCreationProgram>,
    #[serde(rename = "schema")]
    _schema: ApplyStudioCreationEditSchemaV1,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
    viewport: StudioAuthoringSize,
}

impl From<ApplyStudioCreationEditCommandJsonV1> for ApplyStudioCreationEditCommand {
    fn from(value: ApplyStudioCreationEditCommandJsonV1) -> Self {
        Self {
            evaluated_duration: value.evaluated_duration,
            evaluated_entities: value.evaluated_entities,
            evaluated_events: value.evaluated_events,
            expected_base_revision: value.expected_base_revision,
            frame: value.frame,
            math_tex_outlines: value.math_tex_outlines,
            next_revision: value.next_revision,
            programs: value.programs,
            viewport: value.viewport,
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum SceneAuthoringAdapterError {
    #[error("{command} command contains {actual_bytes} bytes; maximum is {maximum_bytes}")]
    CommandTooLarge {
        command: &'static str,
        actual_bytes: usize,
        maximum_bytes: usize,
    },
    #[error("invalid {command} command JSON: {source}")]
    CommandJson {
        command: &'static str,
        source: serde_json::Error,
    },
    #[error("invalid Scene authoring snapshot: {0}")]
    Snapshot(#[from] ContractJsonError),
    #[error("the Scene authoring snapshot could not create an Engine session: {0}")]
    Session(#[from] EvaluationError),
    #[error(transparent)]
    CreateMotionCommand(#[from] CreateSceneMotionError),
    #[error(transparent)]
    TimelineCommand(#[from] EditSceneTimelineError),
    #[error(transparent)]
    RotationCommand(#[from] RotateSceneEntityError),
    #[error(transparent)]
    TransformCommand(#[from] TransformSceneEntityError),
    #[error(transparent)]
    StaticRootTransformEdit(#[from] ApplyStaticRootTransformEditError),
    #[error(transparent)]
    StudioCreationEdit(#[from] ApplyStudioCreationEditError),
    #[error(transparent)]
    SetSubtreeVectorPaintAlphaCommand(#[from] SetSubtreeVectorPaintAlphaError),
    #[error("the authored Scene bundle could not be serialized: {0}")]
    ResponseJson(serde_json::Error),
    #[error(
        "the authored Scene bundle contains {actual_bytes} bytes; maximum is {}",
        poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1
    )]
    ResponseTooLarge { actual_bytes: usize },
}

fn parse_scene_authoring_command<T: DeserializeOwned>(
    command: &'static str,
    command_json: &[u8],
) -> Result<T, SceneAuthoringAdapterError> {
    parse_scene_authoring_command_with_limit(
        command,
        command_json,
        MAX_SCENE_AUTHORING_COMMAND_JSON_BYTES_V1,
    )
}

fn parse_scene_authoring_command_with_limit<T: DeserializeOwned>(
    command: &'static str,
    command_json: &[u8],
    maximum_bytes: usize,
) -> Result<T, SceneAuthoringAdapterError> {
    if command_json.len() > maximum_bytes {
        return Err(SceneAuthoringAdapterError::CommandTooLarge {
            command,
            actual_bytes: command_json.len(),
            maximum_bytes,
        });
    }
    serde_json::from_slice(command_json)
        .map_err(|source| SceneAuthoringAdapterError::CommandJson { command, source })
}

fn scene_authoring_session(
    snapshot_json: &[u8],
) -> Result<EngineSessionV1, SceneAuthoringAdapterError> {
    let bundle = parse_scene_ir_bundle_json_v1(snapshot_json)?;
    Ok(EngineSessionV1::new(bundle)?)
}

fn scene_authoring_response(
    bundle: &SceneIrBundleV1,
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let response = serde_json::to_vec(bundle).map_err(SceneAuthoringAdapterError::ResponseJson)?;
    if response.len() > poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1 {
        return Err(SceneAuthoringAdapterError::ResponseTooLarge {
            actual_bytes: response.len(),
        });
    }
    Ok(response)
}

fn transform_scene_entity_json(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let command: TransformSceneEntityCommandJsonV1 =
        parse_scene_authoring_command("transform", command_json)?;
    let mut session = scene_authoring_session(snapshot_json)?;
    let result = session.transform_scene_entity(command.into())?;
    scene_authoring_response(&result)
}

fn transform_scene_entity_at_time_json(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let command: TransformSceneEntityAtTimeCommandJsonV1 =
        parse_scene_authoring_command("transform at time", command_json)?;
    let mut session = scene_authoring_session(snapshot_json)?;
    let result = session.transform_scene_entity_at_time(command.into())?;
    scene_authoring_response(&result)
}

fn apply_static_root_transform_edit_json(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let command: ApplyStaticRootTransformEditCommandJsonV1 =
        parse_scene_authoring_command_with_limit(
            "static root transform edit",
            command_json,
            poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1,
        )?;
    let mut session = scene_authoring_session(snapshot_json)?;
    let result = session.apply_static_root_transform_edit(command.into())?;
    scene_authoring_response(&result)
}

fn apply_studio_creation_edit_json(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let command: ApplyStudioCreationEditCommandJsonV1 = parse_scene_authoring_command_with_limit(
        "Studio creation edit",
        command_json,
        poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1,
    )?;
    let mut session = scene_authoring_session(snapshot_json)?;
    let result = session.apply_studio_creation_edit(command.into())?;
    scene_authoring_response(&result)
}

fn create_scene_motion_json(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let command: CreateSceneMotionCommandJsonV1 =
        parse_scene_authoring_command("create motion", command_json)?;
    let mut session = scene_authoring_session(snapshot_json)?;
    let result = session.create_scene_motion(command.into())?;
    scene_authoring_response(&result)
}

fn edit_scene_timeline_json(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let command: EditSceneTimelineCommandJsonV1 =
        parse_scene_authoring_command("edit timeline", command_json)?;
    let mut session = scene_authoring_session(snapshot_json)?;
    let result = session.edit_scene_timeline(command.into())?;
    scene_authoring_response(&result)
}

/// Applies ordered wait insertions and trailing duration trims through the shared core.
///
/// # Errors
///
/// Returns a JavaScript error for an invalid snapshot, command, or edited result.
#[wasm_bindgen(js_name = editSceneTimelineV1)]
pub fn edit_scene_timeline_v1(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, JsValue> {
    edit_scene_timeline_json(snapshot_json, command_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Applies one complete normalized Studio creation edit through the shared core.
///
/// # Errors
///
/// Returns a JavaScript error for an invalid snapshot, command, or authored result.
#[wasm_bindgen(js_name = applyStudioCreationEditV1)]
pub fn apply_studio_creation_edit_v1(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, JsValue> {
    apply_studio_creation_edit_json(snapshot_json, command_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Creates one atomic multi-target Studio motion through the shared core.
///
/// # Errors
///
/// Returns a JavaScript error for an invalid snapshot, command, or authored result.
#[wasm_bindgen(js_name = createSceneMotionV1)]
pub fn create_scene_motion_v1(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, JsValue> {
    create_scene_motion_json(snapshot_json, command_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Resolves and applies one atomic transform intent through the shared core.
///
/// # Errors
///
/// Returns a JavaScript error for an invalid snapshot, command, or transformed result.
#[wasm_bindgen(js_name = transformSceneEntityV1)]
pub fn transform_scene_entity_v1(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, JsValue> {
    transform_scene_entity_json(snapshot_json, command_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Applies one root transform from an exact Scene time through the shared core.
///
/// # Errors
///
/// Returns a JavaScript error for an invalid snapshot, command, or transformed result.
#[wasm_bindgen(js_name = transformSceneEntityAtTimeV1)]
pub fn transform_scene_entity_at_time_v1(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, JsValue> {
    transform_scene_entity_at_time_json(snapshot_json, command_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Authorizes complete Studio Edit Programs and applies one static imported-root transform.
///
/// # Errors
///
/// Returns a JavaScript error for an invalid snapshot, Studio command, binding, or transform.
#[wasm_bindgen(js_name = applyStaticRootTransformEditV1)]
pub fn apply_static_root_transform_edit_v1(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, JsValue> {
    apply_static_root_transform_edit_json(snapshot_json, command_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

fn set_subtree_vector_paint_alpha_json(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let command: SetSubtreeVectorPaintAlphaCommandJsonV1 =
        parse_scene_authoring_command("set subtree vector paint alpha", command_json)?;
    let mut session = scene_authoring_session(snapshot_json)?;
    let result = session.set_subtree_vector_paint_alpha(command.into())?;
    scene_authoring_response(&result)
}

/// Sets vector paint alpha for one concrete Scene subtree through the shared core.
///
/// # Errors
///
/// Returns a JavaScript error for an invalid snapshot, command, or authored result.
#[wasm_bindgen(js_name = setSubtreeVectorPaintAlphaV1)]
pub fn set_subtree_vector_paint_alpha_v1(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, JsValue> {
    set_subtree_vector_paint_alpha_json(snapshot_json, command_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum RotateSceneEntitySchemaV1 {
    #[serde(rename = "poietra.rotate-scene-entity")]
    RotateSceneEntity,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RotateSceneEntityCommandJsonV1 {
    angle_radians: f64,
    entity_id: String,
    expected_base_revision: String,
    next_revision: String,
    pivot: PointV1,
    provenance: ProvenanceRecordV1,
    #[serde(rename = "schema")]
    _schema: RotateSceneEntitySchemaV1,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
}

impl From<RotateSceneEntityCommandJsonV1> for RotateSceneEntityCommand {
    fn from(value: RotateSceneEntityCommandJsonV1) -> Self {
        Self {
            angle_radians: value.angle_radians,
            entity_id: value.entity_id,
            expected_base_revision: value.expected_base_revision,
            next_revision: value.next_revision,
            pivot: value.pivot,
            provenance: value.provenance,
        }
    }
}

fn rotate_scene_entity_json(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let command: RotateSceneEntityCommandJsonV1 =
        parse_scene_authoring_command("rotation", command_json)?;
    let mut session = scene_authoring_session(snapshot_json)?;
    let result = session.rotate_scene_entity(command.into())?;
    scene_authoring_response(&result)
}

/// Applies one concrete Scene rotation through the shared native/WASM core.
///
/// # Errors
///
/// Returns a JavaScript error for an invalid snapshot, command, or rotated result.
#[wasm_bindgen(js_name = rotateSceneEntityV1)]
pub fn rotate_scene_entity_v1(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, JsValue> {
    rotate_scene_entity_json(snapshot_json, command_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use poietra_scene_ir::{
        AnimationChannelV1, RenderDrawV1, SceneAppearanceV1, SceneGeometryV1, SceneSourceV1,
        parse_scene_ir_bundle_json_v1,
    };
    use serde_json::json;

    use super::*;
    use crate::EngineWorkerSessionV1;

    fn fixture_json() -> Vec<u8> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/engine-v1/shared-circle-opacity.json");
        let fixture: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        serde_json::to_vec(&json!({
            "assets": fixture["assets"],
            "scene": fixture["scene"],
        }))
        .unwrap()
    }

    fn static_fixture_json() -> Vec<u8> {
        let mut fixture: serde_json::Value =
            serde_json::from_slice(&fixture_json()).expect("fixture must be JSON");
        fixture["scene"]["animationChannels"] = json!([]);
        fixture["scene"]["requiredCapabilities"] = json!(["shape-primitives"]);
        fixture["scene"]["source"] = json!({
            "kind": "imported-manim-server-snapshot",
            "runtimeConfigHash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "snapshotHash": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "snapshotVersion": 1,
            "sourceHash": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        });
        serde_json::to_vec(&fixture).unwrap()
    }

    fn static_root_transform_command_json() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "expectedBaseRevision": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "frame": { "height": 9.0, "width": 16.0 },
            "nextRevision": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "operations": [{
                "anchorSeconds": 0.0,
                "entityId": "source:circle",
                "id": "move-circle",
                "interval": { "end": 0.0, "start": 0.0 },
                "kind": "position",
                "loweringSupported": true,
                "origin": "direct-manipulation",
                "position": { "x": 400.0, "y": 180.0 },
                "programOrigin": "direct-manipulation",
                "validationValid": true
            }],
            "schema": "poietra.apply-static-root-transform-edit",
            "sourceRuntimeBindings": [{
                "runtimeEntityId": "later",
                "sourceIdentityKey": "circle",
                "sourceName": "circle"
            }],
            "studioEntities": [{
                "dimensions": { "radius": 0.5 },
                "id": "source:circle",
                "kind": "circle",
                "objectGraphKey": "source:circle",
                "position": { "x": 360.0, "y": 180.0 },
                "provisional": false,
                "scale": 1.0,
                "sourceIdentity": "circle"
            }],
            "version": 1,
            "viewport": { "height": 360.0, "width": 640.0 }
        }))
        .unwrap()
    }

    fn studio_creation_edit_command_json() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "evaluatedDuration": 2.4,
            "evaluatedEntities": [{
                "contentSampleTexParts": [],
                "contentTexParts": null,
                "id": "tx:create/entity:rectangle",
                "kind": "rectangle",
                "lifetimes": [{ "end": 2.4, "start": 0.5 }],
                "objectGraphKey": "tx:create/entity:rectangle",
                "sourceIdentity": null,
                "transactionId": "create"
            }],
            "evaluatedEvents": [],
            "expectedBaseRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "frame": { "height": 9.0, "width": 16.0 },
            "mathTexOutlines": [],
            "nextRevision": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "programs": [{
                "anchorSeconds": 0.5,
                "loweringSupported": true,
                "operations": [
                    {
                        "entity": {
                            "dimensions": { "height": 2.0, "width": 4.0 },
                            "id": "tx:create/entity:rectangle",
                            "kind": "rectangle",
                            "lifetimeStart": 0.5,
                            "texParts": null
                        },
                        "id": "create-rectangle",
                        "interval": { "end": 0.5, "start": 0.5 },
                        "kind": "create"
                    },
                    {
                        "entityId": "tx:create/entity:rectangle",
                        "id": "position-rectangle",
                        "interval": { "end": 0.5, "start": 0.5 },
                        "kind": "position",
                        "position": { "x": 320.0, "y": 180.0 }
                    },
                    {
                        "entityId": "tx:create/entity:rectangle",
                        "id": "fade-rectangle",
                        "interval": { "end": 0.9, "start": 0.5 },
                        "kind": "fade-in",
                        "persistent": true
                    }
                ],
                "scheduleOrder": ["create-rectangle", "position-rectangle", "fade-rectangle"],
                "transactionId": "create",
                "validationValid": true
            }],
            "schema": "poietra.apply-studio-creation-edit",
            "version": 1,
            "viewport": { "height": 360.0, "width": 640.0 }
        }))
        .unwrap()
    }

    fn command_json() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "angleRadians": std::f64::consts::FRAC_PI_2,
            "entityId": "later",
            "expectedBaseRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "nextRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "pivot": { "x": 1.0, "y": 0.0 },
            "provenance": {
                "evidence": ["WASM adapter rotation test"],
                "id": "wasm-rotation",
                "origin": "studio-edit-program"
            },
            "schema": "poietra.rotate-scene-entity",
            "version": 1
        }))
        .unwrap()
    }

    fn timed_transform_command_json() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "at": 1.0,
            "delta": { "x": 2.0, "y": -1.0 },
            "entityId": "later",
            "expectedBaseRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "nextRevision": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "provenance": {
                "evidence": ["WASM adapter endpoint transform test"],
                "id": "wasm-endpoint-transform",
                "origin": "studio-edit-program"
            },
            "scale": {
                "pivot": { "x": 1.0, "y": 0.0 },
                "xFactor": 1.5,
                "yFactor": 1.5
            },
            "schema": "poietra.transform-scene-entity-at-time",
            "version": 1
        }))
        .unwrap()
    }

    fn baseline_transform_command_json(world_center_x: f64) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "entityId": "later",
            "expectedBaseRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "intent": {
                "baseline": {
                    "height": 1.0,
                    "kind": "world-size",
                    "width": 1.0,
                    "worldCenter": { "x": world_center_x, "y": 0.0 }
                },
                "kind": "from-baseline",
                "scale": { "xFactor": 1.5, "yFactor": 1.5 },
                "targetCenter": { "x": 3.0, "y": -1.0 }
            },
            "nextRevision": "8888888888888888888888888888888888888888888888888888888888888888",
            "provenance": {
                "evidence": ["WASM adapter verified transform baseline"],
                "id": "wasm-baseline-transform",
                "origin": "studio-edit-program"
            },
            "schema": "poietra.transform-scene-entity",
            "version": 1
        }))
        .unwrap()
    }

    fn current_uniform_transform_command_json() -> Vec<u8> {
        let mut command: serde_json::Value =
            serde_json::from_slice(&baseline_transform_command_json(1.0)).unwrap();
        command["intent"]["baseline"] = json!({ "kind": "current-uniform-affine" });
        serde_json::to_vec(&command).unwrap()
    }

    fn current_center_transform_command_json() -> Vec<u8> {
        let mut command: serde_json::Value =
            serde_json::from_slice(&baseline_transform_command_json(1.0)).unwrap();
        command["intent"]["baseline"] = json!({ "kind": "current-center" });
        command["intent"].as_object_mut().unwrap().remove("scale");
        serde_json::to_vec(&command).unwrap()
    }

    fn create_motion_command_json() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "controlOffset": { "x": 0.0, "y": 4.0 },
            "delta": { "x": 6.0, "y": 2.0 },
            "easing": "smooth",
            "expectedBaseRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "interval": { "end": 1.5, "start": 0.5 },
            "nextRevision": "9999999999999999999999999999999999999999999999999999999999999999",
            "provenance": {
                "evidence": ["WASM adapter motion test"],
                "id": "wasm-create-motion",
                "origin": "studio-edit-program"
            },
            "schema": "poietra.create-scene-motion",
            "targetEntityIds": ["later", "stroke"],
            "version": 1
        }))
        .unwrap()
    }

    fn edit_timeline_command_json() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "edits": [
                { "at": 0.5, "duration": 0.5, "kind": "insert-wait" },
                { "at": 1.0, "kind": "trim-scene-duration", "removedDuration": 0.2, "targetDuration": 2.3 }
            ],
            "expectedBaseRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "nextRevision": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "provenance": {
                "evidence": ["WASM adapter timeline edit test"],
                "id": "wasm-timeline-edit",
                "origin": "studio-edit-program"
            },
            "schema": "poietra.edit-scene-timeline",
            "version": 1
        }))
        .unwrap()
    }

    fn set_subtree_vector_paint_alpha_command_json(root_entity_id: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "alpha": 0.25,
            "expectedBaseRevision": "53fd284f9fd30f8223f90dfc9c291d571bab25d61b55170d5e57cf346e1b2827",
            "nextRevision": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            "provenance": {
                "evidence": ["WASM adapter subtree vector paint alpha test"],
                "id": "wasm-subtree-vector-paint-alpha",
                "origin": "studio-edit-program"
            },
            "rootEntityId": root_entity_id,
            "schema": "poietra.set-subtree-vector-paint-alpha",
            "version": 1
        }))
        .unwrap()
    }

    fn interaction_clip_bounds(
        snapshot_json: &[u8],
        entity_id: &str,
        sample_time: f64,
    ) -> ([f32; 4], f64, f64) {
        let session = EngineWorkerSessionV1::from_snapshot_json(snapshot_json).unwrap();
        let request = serde_json::to_vec(&json!({
            "evidence": ["WASM authoring interaction bounds test"],
            "interactionEntityIds": [entity_id],
            "packetId": "wasm-authoring:interaction-bounds",
            "sampleTime": sample_time,
            "schema": "poietra.engine-sample-request",
            "version": 1,
            "viewport": { "heightPx": 90, "widthPx": 160 }
        }))
        .unwrap();
        let sampled = session.sample_packet_json(&request).unwrap();
        let camera_width = sampled.packet.camera.right - sampled.packet.camera.left;
        let camera_height = sampled.packet.camera.top - sampled.packet.camera.bottom;
        let prepared = poietra_render_wgpu::prepare_frame_v1(&sampled.packet).unwrap();
        let bounds = prepared
            .interaction_clip_bounds_by_entity(session.scene())
            .unwrap()
            .get(entity_id)
            .copied()
            .unwrap();

        (bounds, camera_width, camera_height)
    }

    #[test]
    fn moved_real_top_level_group_shifts_its_prepared_descendant_bounds() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/engine-v1/real-line-joints-v10.json");
        let fixture: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        let snapshot = serde_json::to_vec(&json!({
            "assets": fixture["assets"],
            "scene": fixture["scene"],
        }))
        .unwrap();
        let bundle = parse_scene_ir_bundle_json_v1(&snapshot).unwrap();
        let root = bundle
            .scene
            .entities
            .iter()
            .find(|entity| {
                entity.parent_id.is_none() && matches!(entity.geometry, SceneGeometryV1::Group {})
            })
            .expect("the real LineJoints fixture must retain its top-level VGroup");
        let root_id = root.id.clone();
        let command = serde_json::to_vec(&json!({
            "entityId": root_id,
            "expectedBaseRevision": bundle.scene.source.revision_hash(),
            "intent": {
                "delta": { "x": 2.5, "y": -1.5 },
                "kind": "relative"
            },
            "nextRevision": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "provenance": {
                "evidence": ["WASM adapter real top-level group move test"],
                "id": "wasm-real-group-move",
                "origin": "studio-edit-program"
            },
            "schema": "poietra.transform-scene-entity",
            "version": 1
        }))
        .unwrap();
        let (before, camera_width, camera_height) =
            interaction_clip_bounds(&snapshot, &root_id, 0.5);
        let moved_snapshot = transform_scene_entity_json(&snapshot, &command).unwrap();
        let (after, moved_camera_width, moved_camera_height) =
            interaction_clip_bounds(&moved_snapshot, &root_id, 0.5);

        assert!((moved_camera_width - camera_width).abs() < 1e-12);
        assert!((moved_camera_height - camera_height).abs() < 1e-12);
        let expected_clip_delta = [2.0 * 2.5 / camera_width, 2.0 * -1.5 / camera_height];
        for (edge, (before_edge, after_edge)) in before.into_iter().zip(after).enumerate() {
            let expected = f64::from(before_edge) + expected_clip_delta[edge % 2];
            assert!(
                (f64::from(after_edge) - expected).abs() < 1e-5,
                "edge {edge} moved to {after_edge}, expected {expected}"
            );
        }
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the wire command applies exact finite values around its derived center"
    )]
    fn baseline_transform_intent_verifies_the_baseline_before_mutation() {
        let snapshot = fixture_json();
        let response =
            transform_scene_entity_json(&snapshot, &baseline_transform_command_json(1.0)).unwrap();
        let authored = parse_scene_ir_bundle_json_v1(&response).unwrap();
        let target = authored
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();
        assert_eq!(target.transform.m11, 1.5);
        assert_eq!(target.transform.m22, 1.5);
        assert_eq!(target.transform.tx, 1.5);
        assert_eq!(target.transform.ty, -1.0);
        assert!(matches!(
            transform_scene_entity_json(&snapshot, &baseline_transform_command_json(1.25)),
            Err(SceneAuthoringAdapterError::TransformCommand(
                TransformSceneEntityError::BaselineMismatch
            ))
        ));
        assert!(
            transform_scene_entity_json(&snapshot, &current_uniform_transform_command_json())
                .is_ok()
        );
        assert!(
            transform_scene_entity_json(&snapshot, &current_center_transform_command_json())
                .is_ok()
        );

        let mut centered = parse_scene_ir_bundle_json_v1(&snapshot).unwrap();
        let centered_target = centered
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == "later")
            .unwrap();
        let SceneGeometryV1::Circle { center, .. } = &mut centered_target.geometry else {
            panic!("fixture target must be a Circle");
        };
        *center = PointV1 { x: 0.0, y: 0.0 };
        centered_target.transform.tx = 3.0;
        centered_target.transform.ty = -2.0;
        let centered_snapshot = serde_json::to_vec(&centered).unwrap();
        let mut scale_only: serde_json::Value =
            serde_json::from_slice(&baseline_transform_command_json(3.0 + 1.0e-10)).unwrap();
        scale_only["intent"]["baseline"]["worldCenter"]["y"] = json!(-2.0);
        scale_only["intent"]
            .as_object_mut()
            .unwrap()
            .remove("targetCenter");
        let scale_only_response = transform_scene_entity_json(
            &centered_snapshot,
            &serde_json::to_vec(&scale_only).unwrap(),
        )
        .unwrap();
        let scale_only_authored = parse_scene_ir_bundle_json_v1(&scale_only_response).unwrap();
        let scale_only_target = scale_only_authored
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();
        assert_eq!(scale_only_target.transform.tx, 3.0);
        assert_eq!(scale_only_target.transform.ty, -2.0);
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the adapter must preserve prior prepared bounds and exact stored affine values"
    )]
    fn timed_transform_wire_preserves_prior_frames_and_existing_channels() {
        let snapshot = fixture_json();
        let original = parse_scene_ir_bundle_json_v1(&snapshot).unwrap();
        let original_channels = original.scene.animation_channels.clone();
        let (before_original, _, _) = interaction_clip_bounds(&snapshot, "later", 0.5);

        let response =
            transform_scene_entity_at_time_json(&snapshot, &timed_transform_command_json())
                .unwrap();
        let authored = parse_scene_ir_bundle_json_v1(&response).unwrap();
        let (before_authored, _, _) = interaction_clip_bounds(&response, "later", 0.5);
        let (at_authored, camera_width, camera_height) =
            interaction_clip_bounds(&response, "later", 1.0);

        assert_eq!(before_authored, before_original);
        assert_eq!(
            &authored.scene.animation_channels[..original_channels.len()],
            original_channels
        );
        assert!(matches!(
            authored.scene.animation_channels.last(),
            Some(AnimationChannelV1::AffineTransform {
                entity_id,
                keyframes,
                provenance_id,
                ..
            }) if entity_id == "later"
                && provenance_id == "wasm-endpoint-transform"
                && keyframes[0].at == 1.0
                && keyframes[0].value.m11 == 1.5
                && keyframes[0].value.m22 == 1.5
                && keyframes[0].value.tx == 1.5
                && keyframes[0].value.ty == -1.0
                && keyframes[1].value == keyframes[0].value
        ));
        let before_width = before_original[2] - before_original[0];
        let before_height = before_original[3] - before_original[1];
        assert!(((at_authored[2] - at_authored[0]) / before_width - 1.5).abs() < 1e-5);
        assert!(((at_authored[3] - at_authored[1]) / before_height - 1.5).abs() < 1e-5);
        let expected_clip_delta = [4.0 / camera_width, -2.0 / camera_height];
        let before_center = [
            before_original[0].midpoint(before_original[2]),
            before_original[1].midpoint(before_original[3]),
        ];
        let at_center = [
            at_authored[0].midpoint(at_authored[2]),
            at_authored[1].midpoint(at_authored[3]),
        ];
        for axis in 0..2 {
            assert!(
                (f64::from(at_center[axis] - before_center[axis]) - expected_clip_delta[axis])
                    .abs()
                    < 1e-5
            );
        }
    }

    #[test]
    fn axis_scaled_real_top_level_group_changes_its_prepared_aggregate_bounds() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/engine-v1/real-line-joints-v10.json");
        let fixture: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        let snapshot = serde_json::to_vec(&json!({
            "assets": fixture["assets"],
            "scene": fixture["scene"],
        }))
        .unwrap();
        let bundle = parse_scene_ir_bundle_json_v1(&snapshot).unwrap();
        let root = bundle
            .scene
            .entities
            .iter()
            .find(|entity| {
                entity.parent_id.is_none() && matches!(entity.geometry, SceneGeometryV1::Group {})
            })
            .expect("the real LineJoints fixture must retain its top-level VGroup");
        let root_id = root.id.clone();
        let command = serde_json::to_vec(&json!({
            "entityId": root_id,
            "expectedBaseRevision": bundle.scene.source.revision_hash(),
            "intent": {
                "delta": { "x": 0.0, "y": 0.0 },
                "kind": "relative",
                "scale": {
                    "pivot": { "x": 1.0, "y": -0.5 },
                    "xFactor": 0.5,
                    "yFactor": 0.75
                }
            },
            "nextRevision": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "provenance": {
                "evidence": ["WASM adapter real top-level group axis scale test"],
                "id": "wasm-real-group-axis-scale",
                "origin": "studio-edit-program"
            },
            "schema": "poietra.transform-scene-entity",
            "version": 1
        }))
        .unwrap();
        let (before, camera_width, camera_height) =
            interaction_clip_bounds(&snapshot, &root_id, 0.5);
        let scaled_snapshot = transform_scene_entity_json(&snapshot, &command).unwrap();
        let (after, scaled_camera_width, scaled_camera_height) =
            interaction_clip_bounds(&scaled_snapshot, &root_id, 0.5);

        assert!((scaled_camera_width - camera_width).abs() < 1e-12);
        assert!((scaled_camera_height - camera_height).abs() < 1e-12);
        assert!(
            after
                .into_iter()
                .zip(before)
                .any(|(left, right)| left.to_bits() != right.to_bits())
        );
        assert!(after.into_iter().all(f32::is_finite));
        assert!(after[0] < after[2]);
        assert!(after[1] < after[3]);
        assert!(after[2] - after[0] < before[2] - before[0]);
        assert!(after[3] - after[1] < before[3] - before[1]);
        let scaled = parse_scene_ir_bundle_json_v1(&scaled_snapshot).unwrap();
        let scaled_root = scaled
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == root_id)
            .unwrap();
        assert!((scaled_root.transform.m11 - 0.5).abs() < 1e-12);
        assert!((scaled_root.transform.m22 - 0.75).abs() < 1e-12);
        assert!((scaled_root.transform.tx - 0.5).abs() < 1e-12);
        assert!((scaled_root.transform.ty + 0.125).abs() < 1e-12);
        assert_eq!(scaled_root.provenance_id, "wasm-real-group-axis-scale");
        assert!(matches!(
            scaled.scene.source,
            SceneSourceV1::StudioEditProgram { revision_hash, .. }
                if revision_hash == "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
        ));
    }

    #[test]
    fn subtree_vector_paint_alpha_updates_real_strokes_and_sampled_materials() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/engine-v1/real-line-joints-v10.json");
        let fixture: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        let snapshot = serde_json::to_vec(&json!({
            "assets": fixture["assets"],
            "scene": fixture["scene"],
        }))
        .unwrap();
        let bundle = parse_scene_ir_bundle_json_v1(&snapshot).unwrap();
        let root = bundle
            .scene
            .entities
            .iter()
            .find(|entity| {
                entity.parent_id.is_none() && matches!(entity.geometry, SceneGeometryV1::Group {})
            })
            .expect("the real LineJoints fixture must retain its top-level VGroup");
        let response = set_subtree_vector_paint_alpha_json(
            &snapshot,
            &set_subtree_vector_paint_alpha_command_json(&root.id),
        )
        .unwrap();
        let authored = parse_scene_ir_bundle_json_v1(&response).unwrap();
        let changed_vectors: Vec<_> = authored
            .scene
            .entities
            .iter()
            .filter_map(|entity| match &entity.appearance {
                SceneAppearanceV1::Vector {
                    fill: None,
                    stroke: Some(stroke),
                    ..
                } => Some((entity, stroke)),
                _ => None,
            })
            .collect();

        assert_eq!(changed_vectors.len(), 3);
        for (entity, stroke) in changed_vectors {
            assert!((stroke.color.alpha - 0.25).abs() < 1e-12);
            assert_eq!(entity.provenance_id, "wasm-subtree-vector-paint-alpha");
        }
        assert!(matches!(
            authored.scene.source,
            SceneSourceV1::StudioEditProgram { revision_hash, .. }
                if revision_hash == "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        ));

        let session = EngineWorkerSessionV1::from_snapshot_json(&response).unwrap();
        let request = serde_json::to_vec(&json!({
            "evidence": ["WASM subtree paint alpha sampled material test"],
            "interactionEntityIds": [],
            "packetId": "wasm-authoring:subtree-paint-alpha",
            "sampleTime": 0.5,
            "schema": "poietra.engine-sample-request",
            "version": 1,
            "viewport": { "heightPx": 90, "widthPx": 160 }
        }))
        .unwrap();
        let sampled = session.sample_packet_json(&request).unwrap();
        let stroke_alphas: Vec<_> = sampled
            .packet
            .draws
            .iter()
            .filter_map(|draw| match draw {
                RenderDrawV1::Path {
                    stroke: Some(stroke),
                    ..
                } => Some(stroke.color.alpha),
                _ => None,
            })
            .collect();
        assert_eq!(stroke_alphas, vec![0.25; 3]);
        let prepared = poietra_render_wgpu::prepare_frame_v1(&sampled.packet).unwrap();
        assert_eq!(prepared.material_plan().materials().len(), 3);
        assert!(prepared.material_plan().materials().iter().all(|material| {
            (material.premultiplied_linear_color()[3] - 0.25).abs() < f32::EPSILON
        }));
    }

    #[test]
    fn subtree_vector_paint_alpha_adapter_rejects_unknown_and_oversized_commands() {
        let mut command: serde_json::Value =
            serde_json::from_slice(&set_subtree_vector_paint_alpha_command_json("root")).unwrap();
        command["profile"] = json!("generic-runtime-trace-v3");
        let error = set_subtree_vector_paint_alpha_json(
            &fixture_json(),
            &serde_json::to_vec(&command).unwrap(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("unknown field `profile`"));

        let oversized = vec![b' '; MAX_SCENE_AUTHORING_COMMAND_JSON_BYTES_V1 + 1];
        let error = set_subtree_vector_paint_alpha_json(&fixture_json(), &oversized).unwrap_err();
        assert!(matches!(
            error,
            SceneAuthoringAdapterError::CommandTooLarge {
                command: "set subtree vector paint alpha",
                actual_bytes,
                maximum_bytes: MAX_SCENE_AUTHORING_COMMAND_JSON_BYTES_V1,
            } if actual_bytes == MAX_SCENE_AUTHORING_COMMAND_JSON_BYTES_V1 + 1
        ));
    }

    #[test]
    fn adapter_parses_the_wire_command_and_returns_the_complete_bundle() {
        let response = rotate_scene_entity_json(&fixture_json(), &command_json()).unwrap();
        let bundle = parse_scene_ir_bundle_json_v1(&response).unwrap();
        let rotated = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();

        assert!(rotated.transform.m11.abs() < 1e-12);
        assert!((rotated.transform.m12 + 1.0).abs() < 1e-12);
        assert!((rotated.transform.m21 - 1.0).abs() < 1e-12);
        assert!(rotated.transform.m22.abs() < 1e-12);
        assert_eq!(rotated.provenance_id, "wasm-rotation");
        assert!(matches!(
            bundle.scene.source,
            SceneSourceV1::StudioEditProgram { revision_hash, .. }
                if revision_hash == "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        ));
    }

    #[test]
    fn static_root_transform_adapter_forwards_the_closed_command_to_the_core() {
        let response = apply_static_root_transform_edit_json(
            &static_fixture_json(),
            &static_root_transform_command_json(),
        )
        .unwrap();
        let bundle = parse_scene_ir_bundle_json_v1(&response).unwrap();
        let moved = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();

        assert!((moved.transform.tx - 1.0).abs() < f64::EPSILON);
        assert!(matches!(
            bundle.scene.source,
            SceneSourceV1::StudioEditProgram { revision_hash, .. }
                if revision_hash == "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        ));
    }

    #[test]
    fn studio_creation_adapter_forwards_the_complete_command_to_the_core() {
        let response =
            apply_studio_creation_edit_json(&fixture_json(), &studio_creation_edit_command_json())
                .unwrap();
        let bundle = parse_scene_ir_bundle_json_v1(&response).unwrap();
        let created = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "tx:create/entity:rectangle")
            .unwrap();

        assert!((bundle.scene.duration - 2.4).abs() < f64::EPSILON);
        assert!(matches!(
            created.geometry,
            SceneGeometryV1::Rectangle {
                height: 2.0,
                width: 4.0,
                ..
            }
        ));
        assert!(matches!(
            bundle.scene.source,
            SceneSourceV1::StudioEditProgram { revision_hash, .. }
                if revision_hash == "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
        ));
    }

    #[test]
    fn studio_creation_adapter_rejects_unknown_stale_and_oversized_commands() {
        let mut unknown: serde_json::Value =
            serde_json::from_slice(&studio_creation_edit_command_json()).unwrap();
        unknown["profile"] = json!("legacy");
        let error = apply_studio_creation_edit_json(
            &fixture_json(),
            &serde_json::to_vec(&unknown).unwrap(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("unknown field `profile`"));

        let mut stale: serde_json::Value =
            serde_json::from_slice(&studio_creation_edit_command_json()).unwrap();
        stale["expectedBaseRevision"] = json!("f".repeat(64));
        let error =
            apply_studio_creation_edit_json(&fixture_json(), &serde_json::to_vec(&stale).unwrap())
                .unwrap_err();
        assert!(matches!(
            error,
            SceneAuthoringAdapterError::StudioCreationEdit(ApplyStudioCreationEditError::Create(
                poietra_eval::CreateSceneEntitiesError::StaleBaseRevision
            ))
        ));

        let oversized = vec![b' '; poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1 + 1];
        let error = apply_studio_creation_edit_json(&fixture_json(), &oversized).unwrap_err();
        assert!(matches!(
            error,
            SceneAuthoringAdapterError::CommandTooLarge {
                command: "Studio creation edit",
                actual_bytes,
                maximum_bytes: poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1,
            } if actual_bytes == poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1 + 1
        ));
    }

    #[test]
    fn motion_adapter_forwards_the_strict_command_to_the_core() {
        let response =
            create_scene_motion_json(&fixture_json(), &create_motion_command_json()).unwrap();
        let bundle = parse_scene_ir_bundle_json_v1(&response).unwrap();
        let motions: Vec<_> = bundle
            .scene
            .animation_channels
            .iter()
            .filter_map(|channel| match channel {
                AnimationChannelV1::MotionPath {
                    entity_id,
                    keyframes,
                    orient_to_path,
                    parameterization,
                    path,
                    provenance_id,
                    ..
                } => Some((
                    entity_id,
                    keyframes,
                    orient_to_path,
                    parameterization,
                    path,
                    provenance_id,
                )),
                _ => None,
            })
            .collect();

        assert_eq!(motions.len(), 2);
        for (entity_id, keyframes, orient, parameterization, path, provenance_id) in motions {
            assert!(entity_id == "later" || entity_id == "stroke");
            assert!(matches!(
                keyframes[0].easing_to_next,
                Some(poietra_scene_ir::EasingV1::ManimSmooth {})
            ));
            assert_eq!((keyframes[0].at, keyframes[1].at), (0.5, 1.5));
            assert!(!orient);
            assert_eq!(
                *parameterization,
                Some(poietra_scene_ir::MotionPathParameterizationV1::ManimPointFromProportionV1)
            );
            assert_eq!(path.subpaths.len(), 1);
            assert_eq!(path.subpaths[0].segments.len(), 1);
            assert_eq!(provenance_id, "wasm-create-motion");
        }
        assert!(
            bundle
                .scene
                .required_capabilities
                .contains(&poietra_scene_ir::SceneCapabilityV1::MotionPathAnimation)
        );
        assert!(matches!(
            bundle.scene.source,
            SceneSourceV1::StudioEditProgram { revision_hash, .. }
                if revision_hash == "9999999999999999999999999999999999999999999999999999999999999999"
        ));
    }

    #[test]
    fn motion_adapter_rejects_unknown_and_stale_commands() {
        let mut unknown: serde_json::Value =
            serde_json::from_slice(&create_motion_command_json()).unwrap();
        unknown["profile"] = json!("generic-runtime-trace-v3");
        let error =
            create_scene_motion_json(&fixture_json(), &serde_json::to_vec(&unknown).unwrap())
                .unwrap_err();
        assert!(error.to_string().contains("unknown field `profile`"));

        let mut stale: serde_json::Value =
            serde_json::from_slice(&create_motion_command_json()).unwrap();
        stale["expectedBaseRevision"] = json!("f".repeat(64));
        let error = create_scene_motion_json(&fixture_json(), &serde_json::to_vec(&stale).unwrap())
            .unwrap_err();
        assert!(matches!(
            error,
            SceneAuthoringAdapterError::CreateMotionCommand(
                CreateSceneMotionError::StaleBaseRevision
            )
        ));
    }

    #[test]
    fn timeline_adapter_forwards_wait_and_trim_to_the_core() {
        let response =
            edit_scene_timeline_json(&fixture_json(), &edit_timeline_command_json()).unwrap();
        let bundle = parse_scene_ir_bundle_json_v1(&response).unwrap();

        assert!((bundle.scene.duration - 2.3).abs() < 1e-12);
        assert!(
            bundle
                .scene
                .entities
                .iter()
                .all(|entity| { (entity.lifetimes[0].end - 2.3).abs() < 1e-12 })
        );
        assert!(matches!(
            &bundle.scene.animation_channels[0],
            AnimationChannelV1::Opacity { keyframes, .. }
                if (keyframes[1].at - 2.3).abs() < 1e-12
        ));
        assert_eq!(
            bundle.scene.provenance.last().unwrap().id,
            "wasm-timeline-edit"
        );
        assert!(matches!(
            bundle.scene.source,
            SceneSourceV1::StudioEditProgram { revision_hash, .. }
                if revision_hash == "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        ));
    }

    #[test]
    fn transform_adapter_rejects_unknown_and_oversized_commands() {
        let mut command = json!({
            "entityId": "later",
            "expectedBaseRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "intent": {
                "delta": { "x": 1.0, "y": 0.0 },
                "kind": "relative"
            },
            "nextRevision": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "provenance": {
                "evidence": ["WASM adapter transform validation"],
                "id": "wasm-transform-validation",
                "origin": "studio-edit-program"
            },
            "schema": "poietra.transform-scene-entity",
            "version": 1
        });
        command["profile"] = json!("generic-runtime-trace-v3");

        let error =
            transform_scene_entity_json(&fixture_json(), &serde_json::to_vec(&command).unwrap())
                .unwrap_err();

        assert!(error.to_string().contains("unknown field `profile`"));

        let oversized = vec![b' '; MAX_SCENE_AUTHORING_COMMAND_JSON_BYTES_V1 + 1];
        let error = transform_scene_entity_json(&fixture_json(), &oversized).unwrap_err();

        assert!(matches!(
            error,
            SceneAuthoringAdapterError::CommandTooLarge {
                command: "transform",
                actual_bytes,
                maximum_bytes: MAX_SCENE_AUTHORING_COMMAND_JSON_BYTES_V1,
            } if actual_bytes == MAX_SCENE_AUTHORING_COMMAND_JSON_BYTES_V1 + 1
        ));
    }

    #[test]
    fn shared_response_serializer_rejects_oversized_bundles() {
        let mut bundle = parse_scene_ir_bundle_json_v1(&fixture_json()).unwrap();
        bundle.scene.provenance[0].evidence =
            vec!["x".repeat(poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1)];

        let error = scene_authoring_response(&bundle).unwrap_err();

        assert!(matches!(
            error,
            SceneAuthoringAdapterError::ResponseTooLarge { actual_bytes }
                if actual_bytes > poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1
        ));
    }
}
