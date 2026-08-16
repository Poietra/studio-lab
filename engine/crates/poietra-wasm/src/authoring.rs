use poietra_eval::{
    ApplyStaticRootTransformEditCommand, ApplyStaticRootTransformEditError,
    ApplyStudioBoundEntityEditCommand, ApplyStudioBoundEntityEditError,
    ApplyStudioCreationEditCommand, ApplyStudioCreationEditError,
    ApplyStudioMathTexTransformEditCommand, ApplyStudioMathTexTransformEditError,
    ApplyStudioMotionEditCommand, ApplyStudioMotionEditError, ApplyStudioTimelineEditCommand,
    ApplyStudioTimelineEditError, EngineSessionV1, EvaluationError, ProjectStudioCreationEditError,
    ProjectStudioMotionEditCommand, ProjectStudioMotionEditError, StaticRootTransformProgram,
    StaticRootTransformSize, StaticRootTransformSourceBinding, StaticRootTransformStudioEntity,
    StudioAuthoringEditResult, StudioAuthoringSize, StudioBoundEntityEditCandidate,
    StudioBoundEntityProgram, StudioCreationMathTexOutline, StudioCreationProgram,
    StudioMathTexTransformEntityIdentity, StudioMathTexTransformOutline,
    StudioMathTexTransformProgram, StudioMathTexTransformProjectionEntityIdentity,
    StudioMathTexTransformSourceBinding, StudioMotionEntityIdentity, StudioMotionProgram,
    StudioMotionProjectionBatch, StudioMotionSourceBinding, StudioTimelineProgram,
    project_studio_creation_programs, project_studio_math_tex_transform_programs,
    project_studio_motion_edit, project_studio_timeline_programs,
};
use poietra_scene_ir::{
    ContractJsonError, ContractVersionV1, SceneIrBundleV1, parse_scene_ir_bundle_json_v1,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use wasm_bindgen::prelude::*;

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
enum ProjectStudioCreationEditSchemaV1 {
    #[serde(rename = "poietra.project-studio-creation-edit")]
    ProjectStudioCreationEdit,
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum ApplyStudioTimelineEditSchemaV1 {
    #[serde(rename = "poietra.apply-studio-timeline-edit")]
    ApplyStudioTimelineEdit,
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum ProjectStudioTimelineSchemaV1 {
    #[serde(rename = "poietra.project-studio-timeline")]
    ProjectStudioTimeline,
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum ApplyStudioMotionEditSchemaV1 {
    #[serde(rename = "poietra.apply-studio-motion-edit")]
    ApplyStudioMotionEdit,
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum ProjectStudioMotionEditSchemaV1 {
    #[serde(rename = "poietra.project-studio-motion-edit")]
    ProjectStudioMotionEdit,
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum ApplyStudioMathTexTransformEditSchemaV1 {
    #[serde(rename = "poietra.apply-studio-math-tex-transform-edit")]
    ApplyStudioMathTexTransformEdit,
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum ProjectStudioMathTexTransformSchemaV1 {
    #[serde(rename = "poietra.project-studio-math-tex-transform")]
    ProjectStudioMathTexTransform,
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum ApplyStudioBoundEntityEditSchemaV1 {
    #[serde(rename = "poietra.apply-studio-bound-entity-edit")]
    ApplyStudioBoundEntityEdit,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyStaticRootTransformEditCommandJsonV1 {
    expected_base_revision: String,
    frame: StaticRootTransformSize,
    #[serde(default)]
    math_tex_outlines: Vec<StudioCreationMathTexOutline>,
    next_revision: String,
    programs: Vec<StaticRootTransformProgram>,
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
            math_tex_outlines: value.math_tex_outlines,
            next_revision: value.next_revision,
            programs: value.programs,
            source_runtime_bindings: value.source_runtime_bindings,
            studio_entities: value.studio_entities,
            viewport: value.viewport,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyStudioCreationEditCommandJsonV1 {
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectStudioCreationEditCommandJsonV1 {
    base_duration: f64,
    programs: Vec<StudioCreationProgram>,
    #[serde(rename = "schema")]
    _schema: ProjectStudioCreationEditSchemaV1,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
}

impl From<ApplyStudioCreationEditCommandJsonV1> for ApplyStudioCreationEditCommand {
    fn from(value: ApplyStudioCreationEditCommandJsonV1) -> Self {
        Self {
            expected_base_revision: value.expected_base_revision,
            frame: value.frame,
            math_tex_outlines: value.math_tex_outlines,
            next_revision: value.next_revision,
            programs: value.programs,
            viewport: value.viewport,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyStudioTimelineEditCommandJsonV1 {
    expected_base_revision: String,
    next_revision: String,
    programs: Vec<StudioTimelineProgram>,
    #[serde(rename = "schema")]
    _schema: ApplyStudioTimelineEditSchemaV1,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
}

impl From<ApplyStudioTimelineEditCommandJsonV1> for ApplyStudioTimelineEditCommand {
    fn from(value: ApplyStudioTimelineEditCommandJsonV1) -> Self {
        Self {
            expected_base_revision: value.expected_base_revision,
            next_revision: value.next_revision,
            programs: value.programs,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectStudioTimelineCommandJsonV1 {
    base_duration: f64,
    programs: Vec<StudioTimelineProgram>,
    #[serde(rename = "schema")]
    _schema: ProjectStudioTimelineSchemaV1,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyStudioMotionEditCommandJsonV1 {
    expected_base_revision: String,
    frame: StudioAuthoringSize,
    next_revision: String,
    programs: Vec<StudioMotionProgram>,
    #[serde(rename = "schema")]
    _schema: ApplyStudioMotionEditSchemaV1,
    source_runtime_bindings: Vec<StudioMotionSourceBinding>,
    studio_entities: Vec<StudioMotionEntityIdentity>,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
    viewport: StudioAuthoringSize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectStudioMotionEditCommandJsonV1 {
    base_duration: f64,
    batch: StudioMotionProjectionBatch,
    #[serde(rename = "schema")]
    _schema: ProjectStudioMotionEditSchemaV1,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyStudioMathTexTransformEditCommandJsonV1 {
    expected_base_revision: String,
    frame: StudioAuthoringSize,
    math_tex_outlines: Vec<StudioMathTexTransformOutline>,
    next_revision: String,
    programs: Vec<StudioMathTexTransformProgram>,
    #[serde(rename = "schema")]
    _schema: ApplyStudioMathTexTransformEditSchemaV1,
    source_runtime_bindings: Vec<StudioMathTexTransformSourceBinding>,
    studio_entities: Vec<StudioMathTexTransformEntityIdentity>,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
    viewport: StudioAuthoringSize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectStudioMathTexTransformCommandJsonV1 {
    base_duration: f64,
    programs: Vec<StudioMathTexTransformProgram>,
    #[serde(rename = "schema")]
    _schema: ProjectStudioMathTexTransformSchemaV1,
    studio_entities: Vec<StudioMathTexTransformProjectionEntityIdentity>,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
}

impl From<ApplyStudioMathTexTransformEditCommandJsonV1> for ApplyStudioMathTexTransformEditCommand {
    fn from(value: ApplyStudioMathTexTransformEditCommandJsonV1) -> Self {
        Self {
            expected_base_revision: value.expected_base_revision,
            frame: value.frame,
            math_tex_outlines: value.math_tex_outlines,
            next_revision: value.next_revision,
            programs: value.programs,
            source_runtime_bindings: value.source_runtime_bindings,
            studio_entities: value.studio_entities,
            viewport: value.viewport,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyStudioBoundEntityEditCommandJsonV1 {
    candidates: Vec<StudioBoundEntityEditCandidate>,
    expected_base_revision: String,
    frame: StudioAuthoringSize,
    next_revision: String,
    programs: Vec<StudioBoundEntityProgram>,
    #[serde(rename = "schema")]
    _schema: ApplyStudioBoundEntityEditSchemaV1,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
    viewport: StudioAuthoringSize,
}

impl From<ApplyStudioBoundEntityEditCommandJsonV1> for ApplyStudioBoundEntityEditCommand {
    fn from(value: ApplyStudioBoundEntityEditCommandJsonV1) -> Self {
        Self {
            candidates: value.candidates,
            expected_base_revision: value.expected_base_revision,
            frame: value.frame,
            next_revision: value.next_revision,
            programs: value.programs,
            viewport: value.viewport,
        }
    }
}

impl From<ApplyStudioMotionEditCommandJsonV1> for ApplyStudioMotionEditCommand {
    fn from(value: ApplyStudioMotionEditCommandJsonV1) -> Self {
        Self {
            expected_base_revision: value.expected_base_revision,
            frame: value.frame,
            next_revision: value.next_revision,
            programs: value.programs,
            source_runtime_bindings: value.source_runtime_bindings,
            studio_entities: value.studio_entities,
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
    StudioMotionEdit(#[from] ApplyStudioMotionEditError),
    #[error(transparent)]
    StudioMotionProjection(#[from] ProjectStudioMotionEditError),
    #[error(transparent)]
    StudioMathTexTransformEdit(#[from] ApplyStudioMathTexTransformEditError),
    #[error(transparent)]
    StaticRootTransformEdit(#[from] ApplyStaticRootTransformEditError),
    #[error(transparent)]
    StudioBoundEntityEdit(#[from] ApplyStudioBoundEntityEditError),
    #[error(transparent)]
    StudioCreationEdit(#[from] ApplyStudioCreationEditError),
    #[error(transparent)]
    StudioCreationProjection(#[from] ProjectStudioCreationEditError),
    #[error(transparent)]
    StudioTimelineEdit(#[from] ApplyStudioTimelineEditError),
    #[error("the Scene authoring response could not be serialized: {0}")]
    ResponseJson(serde_json::Error),
    #[error(
        "the Scene authoring response contains {actual_bytes} bytes; maximum is {}",
        poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1
    )]
    ResponseTooLarge { actual_bytes: usize },
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

fn studio_projection_response<T: Serialize>(
    projection: &T,
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let response =
        serde_json::to_vec(projection).map_err(SceneAuthoringAdapterError::ResponseJson)?;
    if response.len() > poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1 {
        return Err(SceneAuthoringAdapterError::ResponseTooLarge {
            actual_bytes: response.len(),
        });
    }
    Ok(response)
}

fn studio_authoring_edit_response(
    result: &StudioAuthoringEditResult,
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let response = serde_json::to_vec(result).map_err(SceneAuthoringAdapterError::ResponseJson)?;
    if response.len() > poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1 {
        return Err(SceneAuthoringAdapterError::ResponseTooLarge {
            actual_bytes: response.len(),
        });
    }
    Ok(response)
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
    studio_authoring_edit_response(&result)
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
    studio_authoring_edit_response(&result)
}

fn project_studio_creation_edit_json(
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let command: ProjectStudioCreationEditCommandJsonV1 = parse_scene_authoring_command_with_limit(
        "Studio creation projection",
        command_json,
        poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1,
    )?;
    let projection = project_studio_creation_programs(command.base_duration, &command.programs)?;
    studio_projection_response(&projection)
}

fn apply_studio_timeline_edit_json(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let command: ApplyStudioTimelineEditCommandJsonV1 = parse_scene_authoring_command_with_limit(
        "Studio timeline edit",
        command_json,
        poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1,
    )?;
    let mut session = scene_authoring_session(snapshot_json)?;
    let result = session.apply_studio_timeline_edit(command.into())?;
    scene_authoring_response(&result)
}

fn project_studio_timeline_json(
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let command: ProjectStudioTimelineCommandJsonV1 = parse_scene_authoring_command_with_limit(
        "Studio timeline projection",
        command_json,
        poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1,
    )?;
    let projection = project_studio_timeline_programs(command.base_duration, &command.programs)?;
    studio_projection_response(&projection)
}

fn apply_studio_motion_edit_json(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let command: ApplyStudioMotionEditCommandJsonV1 = parse_scene_authoring_command_with_limit(
        "Studio motion edit",
        command_json,
        poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1,
    )?;
    let mut session = scene_authoring_session(snapshot_json)?;
    let result = session.apply_studio_motion_edit(command.into())?;
    scene_authoring_response(&result)
}

fn project_studio_motion_edit_json(
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let command: ProjectStudioMotionEditCommandJsonV1 = parse_scene_authoring_command_with_limit(
        "Studio motion projection",
        command_json,
        poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1,
    )?;
    let projection = project_studio_motion_edit(&ProjectStudioMotionEditCommand {
        base_duration: command.base_duration,
        batch: command.batch,
    })?;
    studio_projection_response(&projection)
}

fn apply_studio_math_tex_transform_edit_json(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let command: ApplyStudioMathTexTransformEditCommandJsonV1 =
        parse_scene_authoring_command_with_limit(
            "Studio MathTex transform edit",
            command_json,
            poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1,
        )?;
    let mut session = scene_authoring_session(snapshot_json)?;
    let result = session.apply_studio_math_tex_transform_edit(command.into())?;
    studio_authoring_edit_response(&result)
}

fn project_studio_math_tex_transform_json(
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let command: ProjectStudioMathTexTransformCommandJsonV1 =
        parse_scene_authoring_command_with_limit(
            "Studio MathTex transform projection",
            command_json,
            poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1,
        )?;
    let projection = project_studio_math_tex_transform_programs(
        command.base_duration,
        &command.programs,
        &command.studio_entities,
    )?;
    studio_projection_response(&projection)
}

fn apply_studio_bound_entity_edit_json(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let command: ApplyStudioBoundEntityEditCommandJsonV1 =
        parse_scene_authoring_command_with_limit(
            "Studio bound entity edit",
            command_json,
            poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1,
        )?;
    let mut session = scene_authoring_session(snapshot_json)?;
    let result = session.apply_studio_bound_entity_edit(command.into())?;
    studio_projection_response(&result)
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

/// Projects one complete supported Studio creation edit without requiring a Scene snapshot.
///
/// # Errors
///
/// Returns a JavaScript error for a malformed or unsupported closed-contract command.
#[wasm_bindgen(js_name = projectStudioCreationEditV1)]
pub fn project_studio_creation_edit_v1(command_json: &[u8]) -> Result<Vec<u8>, JsValue> {
    project_studio_creation_edit_json(command_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Applies one complete normalized Studio timeline edit through the shared core.
///
/// # Errors
///
/// Returns a JavaScript error for an invalid snapshot, command, or authored result.
#[wasm_bindgen(js_name = applyStudioTimelineEditV1)]
pub fn apply_studio_timeline_edit_v1(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, JsValue> {
    apply_studio_timeline_edit_json(snapshot_json, command_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Projects normalized Studio timeline Programs without requiring a Scene snapshot.
///
/// # Errors
///
/// Returns a JavaScript error for a malformed or unsupported closed-contract command.
#[wasm_bindgen(js_name = projectStudioTimelineV1)]
pub fn project_studio_timeline_v1(command_json: &[u8]) -> Result<Vec<u8>, JsValue> {
    project_studio_timeline_json(command_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Creates one atomic multi-target Studio motion through the shared core.
///
/// # Errors
///
/// Returns a JavaScript error for an invalid snapshot, command, or authored result.
#[wasm_bindgen(js_name = applyStudioMotionEditV1)]
pub fn apply_studio_motion_edit_v1(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, JsValue> {
    apply_studio_motion_edit_json(snapshot_json, command_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Projects one exact supported motion-bearing Studio batch without a Scene snapshot.
///
/// # Errors
///
/// Returns a JavaScript error for a malformed or unsupported closed-contract command.
#[wasm_bindgen(js_name = projectStudioMotionEditV1)]
pub fn project_studio_motion_edit_v1(command_json: &[u8]) -> Result<Vec<u8>, JsValue> {
    project_studio_motion_edit_json(command_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Applies a static imported `MathTex` replacement chain and optional final motion.
///
/// # Errors
///
/// Returns a JavaScript error for an invalid snapshot, command, or authored result.
#[wasm_bindgen(js_name = applyStudioMathTexTransformEditV1)]
pub fn apply_studio_math_tex_transform_edit_v1(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, JsValue> {
    apply_studio_math_tex_transform_edit_json(snapshot_json, command_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Projects a static imported `MathTex` replacement chain and optional final motion.
///
/// # Errors
///
/// Returns a JavaScript error for a malformed or unsupported closed-contract command.
#[wasm_bindgen(js_name = projectStudioMathTexTransformV1)]
pub fn project_studio_math_tex_transform_v1(command_json: &[u8]) -> Result<Vec<u8>, JsValue> {
    project_studio_math_tex_transform_json(command_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Authorizes and applies one edit to one integration-verified bound Scene root.
///
/// # Errors
///
/// Returns a JavaScript error for an invalid snapshot, command, or authored result.
#[wasm_bindgen(js_name = applyStudioBoundEntityEditV1)]
pub fn apply_studio_bound_entity_edit_v1(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, JsValue> {
    apply_studio_bound_entity_edit_json(snapshot_json, command_json)
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

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use poietra_scene_ir::{
        AnimationChannelV1, SceneAppearanceV1, SceneGeometryV1, SceneSourceV1,
        parse_scene_ir_bundle_json_v1,
    };
    use serde_json::json;

    use super::*;
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

    fn static_math_tex_fixture_json() -> Vec<u8> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/engine-v1/mathtex-nested-radical-fraction.json");
        let mut fixture: serde_json::Value =
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        fixture["scene"]["animationChannels"] = json!([]);
        fixture["scene"]["requiredCapabilities"] = json!(["cubic-path-geometry"]);
        fixture["scene"]["source"] = json!({
            "kind": "imported-manim-server-snapshot",
            "runtimeConfigHash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "snapshotHash": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "snapshotVersion": 1,
            "sourceHash": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        });
        serde_json::to_vec(&json!({
            "assets": fixture["assets"],
            "scene": fixture["scene"]
        }))
        .unwrap()
    }

    fn math_tex_transform_edit_command_json() -> Vec<u8> {
        let fixture_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/engine-v1");
        let source: serde_json::Value = serde_json::from_slice(
            &fs::read(fixture_path.join("mathtex-nested-radical-fraction.json")).unwrap(),
        )
        .unwrap();
        let replacement: serde_json::Value = serde_json::from_slice(
            &fs::read(fixture_path.join("real-mathtex-morph-v5.json")).unwrap(),
        )
        .unwrap();
        let runtime_entity_id = source["scene"]["entities"][0]["id"].as_str().unwrap();
        serde_json::to_vec(&json!({
            "expectedBaseRevision": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "frame": { "height": 8.0, "width": 14.222_222_222_222_221 },
            "mathTexOutlines": [{
                "entityId": "tx:math-tex-transform/entity:b",
                "path": replacement["scene"]["entities"][0]["geometry"]["path"],
                "texParts": ["B"]
            }, {
                "entityId": "tx:math-tex-transform/entity:a-prime",
                "path": source["scene"]["entities"][0]["geometry"]["path"],
                "texParts": ["A"]
            }],
            "nextRevision": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "programs": [{
                "anchorCapturedPlayhead": 0.25,
                "anchorResolvedSeconds": 0.25,
                "anchorSource": { "kind": "playhead", "referenceSeconds": 0.25 },
                "intentCount": 2,
                "loweringSupported": true,
                "operations": [{
                    "dependsOn": [],
                    "id": "transform-a-b",
                    "interval": { "end": 0.75, "start": 0.25 },
                    "kind": "transform-content",
                    "origin": "remote-model",
                    "replacement": {
                        "displayLines": ["B"],
                        "label": "middle",
                        "texParts": ["B"]
                    },
                    "sourceEntityId": "source:formula",
                    "strategy": "transform-matching-tex",
                    "targetEntityId": "tx:math-tex-transform/entity:b",
                    "targetType": null
                }, {
                    "dependsOn": ["transform-a-b"],
                    "id": "transform-b-a",
                    "interval": { "end": 1.25, "start": 0.75 },
                    "kind": "transform-content",
                    "origin": "remote-model",
                    "replacement": {
                        "displayLines": ["A"],
                        "label": "restored",
                        "texParts": ["A"]
                    },
                    "sourceEntityId": "tx:math-tex-transform/entity:b",
                    "strategy": "transform-matching-tex",
                    "targetEntityId": "tx:math-tex-transform/entity:a-prime",
                    "targetType": "MathTex"
                }],
                "origin": "remote-model",
                "requestedExecution": "sequence",
                "scheduleEdgeCount": 2,
                "scheduleMode": "sequence",
                "scheduleOrder": ["transform-a-b", "transform-b-a"],
                "transactionId": "math-tex-transform"
            }],
            "schema": "poietra.apply-studio-math-tex-transform-edit",
            "sourceRuntimeBindings": [{
                "runtimeEntityId": runtime_entity_id,
                "sourceIdentityKey": "formula",
                "sourceName": "formula"
            }],
            "studioEntities": [{
                "objectGraphKey": "source:formula",
                "position": { "x": 800.0, "y": 450.0 },
                "provisional": false,
                "scale": 1.0,
                "sourceIdentity": "formula",
                "type": "math-tex"
            }, {
                "objectGraphKey": "source:unrelated",
                "position": null,
                "provisional": false,
                "scale": 1.0,
                "sourceIdentity": "unrelated",
                "type": "other"
            }],
            "version": 1,
            "viewport": { "height": 900.0, "width": 1600.0 }
        }))
        .unwrap()
    }

    fn math_tex_transform_projection_command_json() -> Vec<u8> {
        let mut command: serde_json::Value =
            serde_json::from_slice(&math_tex_transform_edit_command_json()).unwrap();
        let object = command.as_object_mut().unwrap();
        object.remove("expectedBaseRevision");
        object.remove("frame");
        object.remove("mathTexOutlines");
        object.remove("nextRevision");
        object.remove("sourceRuntimeBindings");
        object.remove("viewport");
        object.insert("baseDuration".to_owned(), json!(2.4));
        object.insert(
            "schema".to_owned(),
            json!("poietra.project-studio-math-tex-transform"),
        );
        for entity in object["studioEntities"].as_array_mut().unwrap() {
            entity
                .as_object_mut()
                .unwrap()
                .insert("lifetime".to_owned(), json!([{ "end": 2.4, "start": 0.0 }]));
        }
        serde_json::to_vec(&command).unwrap()
    }

    fn math_tex_transform_motion_edit_command_json() -> Vec<u8> {
        let mut command: serde_json::Value =
            serde_json::from_slice(&math_tex_transform_edit_command_json()).unwrap();
        let program = &mut command["programs"][0];
        program["intentCount"] = json!(3);
        program["scheduleEdgeCount"] = json!(4);
        program["scheduleOrder"] = json!(["transform-a-b", "transform-b-a", "move-restored"]);
        program["operations"].as_array_mut().unwrap().push(json!({
            "controlOffset": { "x": 0.0, "y": -160.0 },
            "delta": { "x": 160.0, "y": 0.0 },
            "dependsOn": ["transform-b-a"],
            "easing": "smooth",
            "id": "move-restored",
            "interval": { "end": 1.75, "start": 1.5 },
            "kind": "create-motion",
            "origin": "remote-model",
            "targetEntityIds": ["tx:math-tex-transform/entity:a-prime"]
        }));
        serde_json::to_vec(&command).unwrap()
    }

    fn math_tex_transform_motion_projection_command_json() -> Vec<u8> {
        let mut command: serde_json::Value =
            serde_json::from_slice(&math_tex_transform_motion_edit_command_json()).unwrap();
        let object = command.as_object_mut().unwrap();
        object.remove("expectedBaseRevision");
        object.remove("frame");
        object.remove("mathTexOutlines");
        object.remove("nextRevision");
        object.remove("sourceRuntimeBindings");
        object.remove("viewport");
        object.insert("baseDuration".to_owned(), json!(2.4));
        object.insert(
            "schema".to_owned(),
            json!("poietra.project-studio-math-tex-transform"),
        );
        for entity in object["studioEntities"].as_array_mut().unwrap() {
            entity
                .as_object_mut()
                .unwrap()
                .insert("lifetime".to_owned(), json!([{ "end": 2.4, "start": 0.0 }]));
        }
        serde_json::to_vec(&command).unwrap()
    }

    fn static_root_math_tex_content_command_json() -> Vec<u8> {
        let fixture_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/engine-v1");
        let source: serde_json::Value = serde_json::from_slice(
            &fs::read(fixture_path.join("mathtex-nested-radical-fraction.json")).unwrap(),
        )
        .unwrap();
        let replacement: serde_json::Value = serde_json::from_slice(
            &fs::read(fixture_path.join("real-mathtex-morph-v5.json")).unwrap(),
        )
        .unwrap();
        let runtime_entity_id = source["scene"]["entities"][0]["id"].as_str().unwrap();
        serde_json::to_vec(&json!({
            "expectedBaseRevision": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "frame": { "height": 8.0, "width": 14.222_222_222_222_221 },
            "mathTexOutlines": [{
                "entityId": "source:formula",
                "path": replacement["scene"]["entities"][0]["geometry"]["path"],
                "texParts": ["F = ma"]
            }],
            "nextRevision": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "programs": [{
                "anchorCapturedPlayhead": 0.0,
                "anchorResolvedSeconds": 0.0,
                "anchorSource": { "kind": "playhead", "referenceSeconds": 0.0 },
                "intentCount": 1,
                "loweringSupported": true,
                "operations": [{
                    "content": {
                        "displayLines": ["F = ma"],
                        "label": "force",
                        "texParts": ["F = ma"]
                    },
                    "dependsOn": [],
                    "entityId": "source:formula",
                    "id": "set-formula-content",
                    "interval": { "end": 0.0, "start": 0.0 },
                    "kind": "math-tex-content",
                    "origin": "studio-default"
                }],
                "origin": "studio-default",
                "requestedExecution": "parallel",
                "scheduleEdgeCount": 0,
                "scheduleMode": "parallel",
                "scheduleOrder": ["set-formula-content"],
                "transactionId": "set-formula-content"
            }],
            "schema": "poietra.apply-static-root-transform-edit",
            "sourceRuntimeBindings": [{
                "runtimeEntityId": runtime_entity_id,
                "sourceIdentityKey": "formula",
                "sourceName": "formula"
            }],
            "studioEntities": [{
                "dimensions": {},
                "id": "source:formula",
                "kind": "math-tex",
                "objectGraphKey": "source:formula",
                "position": null,
                "provisional": false,
                "scale": 1.75,
                "sourceIdentity": "formula",
                "transactionId": null
            }],
            "version": 1,
            "viewport": { "height": 360.0, "width": 640.0 }
        }))
        .unwrap()
    }

    fn bound_entity_fixture_json() -> Vec<u8> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/engine-v1/real-line-joints-v10.json");
        let fixture: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        serde_json::to_vec(&json!({
            "assets": fixture["assets"],
            "scene": fixture["scene"],
        }))
        .unwrap()
    }

    fn bound_entity_edit_command_json() -> Vec<u8> {
        let snapshot = parse_scene_ir_bundle_json_v1(&bound_entity_fixture_json()).unwrap();
        let root_id = snapshot
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.is_none())
            .unwrap()
            .id
            .clone();
        serde_json::to_vec(&json!({
            "candidates": [{
                "baseCenter": { "x": 320.0, "y": 180.0 },
                "baseOpacity": null,
                "capabilities": {
                    "paintOpacity": true,
                    "rotation": true,
                    "uniformScale": true
                },
                "evidenceId": "line-joints:root",
                "phase": "construction",
                "sceneEntityId": root_id,
                "sourceAnchor": 0.0,
                "studioEntityId": "source:root"
            }],
            "expectedBaseRevision": "d9f5459beb56066e9b4804438aea0d96c310e931138a21d93910b61521bbcc96",
            "frame": { "height": 8.0, "width": 14.222_222_222_222_221 },
            "nextRevision": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            "programs": [{
                "anchorCapturedPlayhead": 0.0,
                "anchorResolvedSeconds": 0.0,
                "anchorSource": { "kind": "absolute", "seconds": 0.0 },
                "intentCount": 1,
                "loweringSupported": true,
                "operations": [{
                    "dependsOn": [],
                    "entityId": "source:root",
                    "id": "move-root",
                    "interval": { "end": 0.0, "start": 0.0 },
                    "kind": "move",
                    "origin": "direct-manipulation",
                    "position": { "x": 360.0, "y": 180.0 }
                }],
                "origin": "direct-manipulation",
                "requestedExecution": "parallel",
                "scheduleEdgeCount": 0,
                "scheduleMode": "parallel",
                "scheduleOrder": ["move-root"],
                "transactionId": "move-root"
            }],
            "schema": "poietra.apply-studio-bound-entity-edit",
            "version": 1,
            "viewport": { "height": 360.0, "width": 640.0 }
        }))
        .unwrap()
    }

    fn static_root_transform_command_json() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "expectedBaseRevision": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "frame": { "height": 9.0, "width": 16.0 },
            "nextRevision": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "programs": [{
                "anchorCapturedPlayhead": 0.0,
                "anchorResolvedSeconds": 0.0,
                "anchorSource": { "kind": "playhead", "referenceSeconds": 0.0 },
                "intentCount": 1,
                "loweringSupported": true,
                "origin": "direct-manipulation",
                "operations": [{
                    "dependsOn": [],
                    "entityId": "source:circle",
                    "id": "move-circle",
                    "interval": { "end": 0.0, "start": 0.0 },
                    "kind": "position",
                    "origin": "direct-manipulation",
                    "position": { "x": 400.0, "y": 180.0 }
                }],
                "requestedExecution": "parallel",
                "scheduleEdgeCount": 0,
                "scheduleMode": "parallel",
                "scheduleOrder": ["move-circle"],
                "transactionId": "move-circle"
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

    #[allow(
        clippy::too_many_lines,
        reason = "one literal fixture keeps the accepted Studio creation wire contract visible"
    )]
    fn studio_creation_edit_command_json() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "expectedBaseRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "frame": { "height": 9.0, "width": 16.0 },
            "mathTexOutlines": [],
            "nextRevision": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "programs": [{
                "anchorCapturedPlayhead": 0.5,
                "anchorResolvedSeconds": 0.5,
                "anchorSource": { "kind": "playhead", "referenceSeconds": 0.5 },
                "intentCount": 1,
                "loweringSupported": true,
                "operations": [
                    {
                        "dependsOn": [],
                        "entity": {
                            "dimensions": { "height": 2.0, "width": 4.0 },
                            "id": "tx:create/entity:rectangle",
                            "kind": "rectangle",
                            "lifetimeEnd": 2.4,
                            "lifetimeStart": 0.5,
                            "texParts": null
                        },
                        "id": "create-rectangle",
                        "interval": { "end": 0.5, "start": 0.5 },
                        "kind": "create",
                        "origin": "studio-default"
                    },
                    {
                        "dependsOn": ["create-rectangle"],
                        "entityId": "tx:create/entity:rectangle",
                        "id": "position-rectangle",
                        "interval": { "end": 0.5, "start": 0.5 },
                        "kind": "position",
                        "origin": "studio-default",
                        "position": { "x": 320.0, "y": 180.0 }
                    },
                    {
                        "dependsOn": ["position-rectangle"],
                        "entityId": "tx:create/entity:rectangle",
                        "id": "fade-rectangle",
                        "interval": { "end": 0.9, "start": 0.5 },
                        "kind": "fade-in",
                        "origin": "studio-default",
                        "persistent": true
                    }
                ],
                "origin": "studio-default",
                "requestedExecution": "parallel",
                "scheduleEdgeCount": 4,
                "scheduleMode": "dependency-dag",
                "scheduleOrder": ["create-rectangle", "position-rectangle", "fade-rectangle"],
                "transactionId": "create"
            }, {
                "anchorCapturedPlayhead": 0.85,
                "anchorResolvedSeconds": 0.85,
                "anchorSource": { "kind": "playhead", "referenceSeconds": 0.85 },
                "intentCount": 1,
                "loweringSupported": true,
                "operations": [{
                    "controlPresent": false,
                    "dependsOn": [],
                    "entityId": "tx:create/entity:rectangle",
                    "from": 1.0,
                    "id": "scale-rectangle",
                    "interval": { "end": 0.85, "start": 0.85 },
                    "kind": "uniform-scale",
                    "origin": "direct-manipulation",
                    "relativeFactor": 1.5,
                    "to": 1.5
                }],
                "origin": "direct-manipulation",
                "requestedExecution": "sequence",
                "scheduleEdgeCount": 0,
                "scheduleMode": "sequence",
                "scheduleOrder": ["scale-rectangle"],
                "transactionId": "scale-rectangle"
            }, {
                "anchorCapturedPlayhead": 0.85,
                "anchorResolvedSeconds": 0.85,
                "anchorSource": { "kind": "playhead", "referenceSeconds": 0.85 },
                "intentCount": 1,
                "loweringSupported": true,
                "operations": [{
                    "dependsOn": [],
                    "entityId": "tx:create/entity:rectangle",
                    "fromDimensions": { "height": 2.0, "width": 4.0 },
                    "fromPosition": { "x": 320.0, "y": 180.0 },
                    "fromScale": 1.5,
                    "id": "resize-rectangle",
                    "interval": { "end": 0.85, "start": 0.85 },
                    "kind": "resize",
                    "origin": "direct-manipulation",
                    "shape": "rectangle",
                    "toDimensions": { "height": 3.0, "width": 6.0 },
                    "toPosition": { "x": 360.0, "y": 180.0 }
                }],
                "origin": "direct-manipulation",
                "requestedExecution": "sequence",
                "scheduleEdgeCount": 0,
                "scheduleMode": "sequence",
                "scheduleOrder": ["resize-rectangle"],
                "transactionId": "resize-rectangle"
            }],
            "schema": "poietra.apply-studio-creation-edit",
            "version": 1,
            "viewport": { "height": 360.0, "width": 640.0 }
        }))
        .unwrap()
    }

    fn studio_creation_projection_command_json() -> Vec<u8> {
        let mut command: serde_json::Value =
            serde_json::from_slice(&studio_creation_edit_command_json()).unwrap();
        let object = command.as_object_mut().unwrap();
        object.remove("expectedBaseRevision");
        object.remove("frame");
        object.remove("mathTexOutlines");
        object.remove("nextRevision");
        object.remove("viewport");
        object.insert("baseDuration".to_owned(), json!(2.0));
        object.insert(
            "schema".to_owned(),
            json!("poietra.project-studio-creation-edit"),
        );
        serde_json::to_vec(&command).unwrap()
    }

    fn studio_timeline_edit_command_json() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "expectedBaseRevision": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "nextRevision": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "programs": [
                {
                    "anchorCapturedPlayhead": 0.5,
                    "anchorResolvedSeconds": 0.5,
                    "anchorSource": { "kind": "absolute", "seconds": 0.5 },
                    "intentCount": 1,
                    "loweringSupported": true,
                    "operations": [{
                        "dependsOn": [],
                        "eventKind": "wait",
                        "id": "extend-scene-duration",
                        "interval": { "end": 1.0, "start": 0.5 },
                        "kind": "insert-wait",
                        "origin": "studio-default",
                        "purpose": "scene-duration"
                    }],
                    "origin": "studio-default",
                    "requestedExecution": "sequence",
                    "scheduleEdgeCount": 0,
                    "scheduleMode": "sequence",
                    "scheduleOrder": ["extend-scene-duration"],
                    "transactionId": "extend-scene-duration"
                },
                {
                    "anchorCapturedPlayhead": 1.0,
                    "anchorResolvedSeconds": 0.5,
                    "anchorSource": { "kind": "absolute", "seconds": 0.5 },
                    "intentCount": 1,
                    "loweringSupported": true,
                    "operations": [{
                        "dependsOn": [],
                        "id": "trim-scene-duration",
                        "interval": { "end": 0.5, "start": 0.5 },
                        "kind": "trim-scene-duration",
                        "origin": "studio-default",
                        "removedDuration": 0.2,
                        "targetDuration": 2.3,
                        "waitOperationIds": ["extend-scene-duration"]
                    }],
                    "origin": "studio-default",
                    "requestedExecution": "sequence",
                    "scheduleEdgeCount": 0,
                    "scheduleMode": "sequence",
                    "scheduleOrder": ["trim-scene-duration"],
                    "transactionId": "trim-scene-duration"
                }
            ],
            "schema": "poietra.apply-studio-timeline-edit",
            "version": 1
        }))
        .unwrap()
    }

    fn studio_timeline_projection_command_json() -> Vec<u8> {
        let apply_command: serde_json::Value =
            serde_json::from_slice(&studio_timeline_edit_command_json()).unwrap();
        serde_json::to_vec(&json!({
            "baseDuration": 2.0,
            "programs": apply_command["programs"],
            "schema": "poietra.project-studio-timeline",
            "version": 1
        }))
        .unwrap()
    }

    fn studio_motion_edit_command_json() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "expectedBaseRevision": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "frame": { "height": 9.0, "width": 16.0 },
            "nextRevision": "9999999999999999999999999999999999999999999999999999999999999999",
            "programs": [{
                "anchorCapturedPlayhead": 0.5,
                "anchorResolvedSeconds": 0.5,
                "anchorSource": { "kind": "playhead", "referenceSeconds": 0.5 },
                "intentCount": 1,
                "loweringSupported": true,
                "operations": [{
                    "controlOffset": { "x": 0.0, "y": -160.0 },
                    "delta": { "x": 240.0, "y": -80.0 },
                    "dependsOn": [],
                    "easing": "smooth",
                    "id": "create-motion",
                    "interval": { "end": 1.5, "start": 0.5 },
                    "kind": "create-motion",
                    "origin": "direct-manipulation",
                    "targetEntityIds": ["source:later", "source:stroke"]
                }],
                "origin": "direct-manipulation",
                "requestedExecution": "sequence",
                "scheduleEdgeCount": 0,
                "scheduleMode": "sequence",
                "scheduleOrder": ["create-motion"],
                "transactionId": "create-motion"
            }],
            "schema": "poietra.apply-studio-motion-edit",
            "sourceRuntimeBindings": [
                {
                    "runtimeEntityId": "later",
                    "sourceIdentityKey": "later-source",
                    "sourceName": "later-source"
                },
                {
                    "runtimeEntityId": "stroke",
                    "sourceIdentityKey": "stroke-source",
                    "sourceName": "stroke-source"
                }
            ],
            "studioEntities": [
                {
                    "objectGraphKey": "source:later",
                    "provisional": false,
                    "sourceIdentity": "later-source"
                },
                {
                    "objectGraphKey": "source:stroke",
                    "provisional": false,
                    "sourceIdentity": "stroke-source"
                }
            ],
            "version": 1,
            "viewport": { "height": 360.0, "width": 640.0 }
        }))
        .unwrap()
    }

    fn studio_motion_projection_command_json() -> Vec<u8> {
        let apply: serde_json::Value =
            serde_json::from_slice(&studio_motion_edit_command_json()).unwrap();
        serde_json::to_vec(&json!({
            "baseDuration": 2.0,
            "batch": {
                "kind": "standalone",
                "programs": apply["programs"],
                "studioEntities": [
                    {
                        "lifetime": [{ "end": 2.0, "start": 0.0 }],
                        "objectGraphKey": "source:later",
                        "position": { "x": 320.0, "y": 180.0 },
                        "provisional": false,
                        "sourceIdentity": "later-source"
                    },
                    {
                        "lifetime": [{ "end": 2.0, "start": 0.0 }],
                        "objectGraphKey": "source:stroke",
                        "position": { "x": 100.0, "y": 80.0 },
                        "provisional": false,
                        "sourceIdentity": "stroke-source"
                    }
                ]
            },
            "schema": "poietra.project-studio-motion-edit",
            "version": 1
        }))
        .unwrap()
    }

    fn assert_bound_entity_effect(case: &str, bundle: &SceneIrBundleV1) {
        let root = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.parent_id.is_none())
            .unwrap();
        match case {
            "construction-move" => {
                assert!((root.transform.tx - 8.0 / 9.0).abs() < 1e-12);
                assert!(root.transform.ty.abs() < 1e-12);
            }
            "construction-opacity" => {
                let mut alphas = Vec::new();
                for entity in &bundle.scene.entities {
                    if let SceneAppearanceV1::Vector { fill, stroke, .. } = &entity.appearance {
                        if let Some(fill) = fill {
                            alphas.push(fill.color.alpha);
                        }
                        if let Some(stroke) = stroke {
                            alphas.push(stroke.color.alpha);
                        }
                    }
                }
                assert!(!alphas.is_empty());
                assert!(alphas.iter().all(|alpha| (*alpha - 0.25).abs() < 1e-12));
            }
            "construction-rotation" => {
                assert!(root.transform.m11.abs() < 1e-12);
                assert!((root.transform.m12 + 1.0).abs() < 1e-12);
                assert!((root.transform.m21 - 1.0).abs() < 1e-12);
                assert!(root.transform.m22.abs() < 1e-12);
            }
            "construction-scale" => {
                assert!((root.transform.m11 - 1.5).abs() < 1e-12);
                assert!((root.transform.m22 - 1.5).abs() < 1e-12);
            }
            "settled-move" => {
                assert!(root.transform.tx.abs() < 1e-12);
                let channel = bundle
                    .scene
                    .animation_channels
                    .iter()
                    .find(|channel| matches!(channel, AnimationChannelV1::AffineTransform { .. }))
                    .unwrap();
                let AnimationChannelV1::AffineTransform { keyframes, .. } = channel else {
                    unreachable!();
                };
                assert!((keyframes[0].at - 0.5).abs() < f64::EPSILON);
                assert!((keyframes[0].value.tx - 8.0 / 9.0).abs() < 1e-12);
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn bound_entity_adapter_deserializes_and_dispatches_every_edit_kind_and_phase() {
        let cases = [
            (
                "construction-move",
                "construction",
                0.0,
                json!({ "kind": "move", "position": { "x": 360.0, "y": 180.0 } }),
                "move",
            ),
            (
                "construction-opacity",
                "construction",
                0.0,
                json!({ "alpha": 0.25, "kind": "opacity" }),
                "opacity",
            ),
            (
                "construction-rotation",
                "construction",
                0.0,
                json!({
                    "controlPresent": false,
                    "from": 0.0,
                    "kind": "rotation",
                    "relativeDelta": std::f64::consts::FRAC_PI_2,
                    "to": std::f64::consts::FRAC_PI_2
                }),
                "rotation",
            ),
            (
                "construction-scale",
                "construction",
                0.0,
                json!({
                    "controlPresent": false,
                    "from": 1.0,
                    "kind": "uniform-scale",
                    "relativeFactor": 1.5,
                    "to": 1.5
                }),
                "resize",
            ),
            (
                "settled-move",
                "settled",
                0.5,
                json!({ "kind": "move", "position": { "x": 360.0, "y": 180.0 } }),
                "move",
            ),
        ];

        for (case, phase, anchor, mut operation, provenance_kind) in cases {
            let fixture = bound_entity_fixture_json();
            let mut command: serde_json::Value =
                serde_json::from_slice(&bound_entity_edit_command_json()).unwrap();
            command["candidates"][0]["phase"] = json!(phase);
            command["candidates"][0]["sourceAnchor"] = json!(anchor);
            command["programs"][0]["anchorCapturedPlayhead"] = json!(anchor);
            command["programs"][0]["anchorResolvedSeconds"] = json!(anchor);
            command["programs"][0]["anchorSource"] =
                json!({ "kind": "absolute", "seconds": anchor });
            operation["dependsOn"] = json!([]);
            operation["entityId"] = json!("source:root");
            operation["id"] = json!(case);
            operation["interval"] = json!({ "end": anchor, "start": anchor });
            operation["origin"] = json!("direct-manipulation");
            command["programs"][0]["operations"] = json!([operation]);
            command["programs"][0]["scheduleOrder"] = json!([case]);

            let response = apply_studio_bound_entity_edit_json(
                &fixture,
                &serde_json::to_vec(&command).unwrap(),
            )
            .unwrap();
            let response: serde_json::Value = serde_json::from_slice(&response).unwrap();
            let bundle =
                parse_scene_ir_bundle_json_v1(&serde_json::to_vec(&response["bundle"]).unwrap())
                    .unwrap();
            let provenance_id = format!(
                "studio-bound-endpoint-{phase}-{provenance_kind}:{}",
                "e".repeat(64)
            );
            let projection_kind = match provenance_kind {
                "move" => "position",
                "opacity" => "opacity",
                "rotation" => "rotation",
                "resize" => "uniform-scale",
                _ => unreachable!(),
            };

            assert_eq!(bundle.scene.provenance.last().unwrap().id, provenance_id);
            assert_eq!(response["projection"]["kind"], projection_kind);
            assert_eq!(response["projection"]["operationId"], case);
            assert_eq!(response["projection"]["studioEntityId"], "source:root");
            assert_eq!(response["projection"]["transactionId"], "move-root");
            assert_eq!(
                response["projection"]["interval"],
                json!({ "end": anchor, "start": anchor })
            );
            assert_bound_entity_effect(case, &bundle);
        }
    }

    #[test]
    fn bound_entity_adapter_rejects_unknown_and_unsupported_commands() {
        let mut unknown: serde_json::Value =
            serde_json::from_slice(&bound_entity_edit_command_json()).unwrap();
        unknown["evaluatedDuration"] = json!(1.0);
        let error = apply_studio_bound_entity_edit_json(
            &bound_entity_fixture_json(),
            &serde_json::to_vec(&unknown).unwrap(),
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("unknown field `evaluatedDuration`")
        );

        let mut unsupported: serde_json::Value =
            serde_json::from_slice(&bound_entity_edit_command_json()).unwrap();
        unsupported["programs"][0]["loweringSupported"] = json!(false);
        let error = apply_studio_bound_entity_edit_json(
            &bound_entity_fixture_json(),
            &serde_json::to_vec(&unsupported).unwrap(),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            SceneAuthoringAdapterError::StudioBoundEntityEdit(
                ApplyStudioBoundEntityEditError::Unsupported
            )
        ));
    }

    #[test]
    fn static_root_transform_adapter_forwards_the_closed_command_to_the_core() {
        let response = apply_static_root_transform_edit_json(
            &static_fixture_json(),
            &static_root_transform_command_json(),
        )
        .unwrap();
        let response: serde_json::Value = serde_json::from_slice(&response).unwrap();
        let bundle =
            parse_scene_ir_bundle_json_v1(&serde_json::to_vec(&response["bundle"]).unwrap())
                .unwrap();
        assert_eq!(
            response["persistentRemoveProjection"]["removals"],
            json!([])
        );
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
        let response: serde_json::Value = serde_json::from_slice(&response).unwrap();
        let bundle =
            parse_scene_ir_bundle_json_v1(&serde_json::to_vec(&response["bundle"]).unwrap())
                .unwrap();
        assert_eq!(
            response["persistentRemoveProjection"]["removals"],
            json!([])
        );
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
        assert!(bundle.scene.animation_channels.iter().any(|channel| {
            matches!(
                channel,
                AnimationChannelV1::AffineTransform {
                    entity_id,
                    keyframes,
                    ..
                } if entity_id == "tx:create/entity:rectangle"
                    && keyframes.first().is_some_and(|keyframe| {
                        (keyframe.value.m11 - 2.25).abs() < f64::EPSILON
                            && (keyframe.value.m22 - 2.25).abs() < f64::EPSILON
                    })
            )
        }));
        assert!(matches!(
            bundle.scene.source,
            SceneSourceV1::StudioEditProgram { revision_hash, .. }
                if revision_hash == "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
        ));
    }

    #[test]
    fn studio_creation_projection_matches_the_full_apply_plan() {
        let projected =
            project_studio_creation_edit_json(&studio_creation_projection_command_json()).unwrap();
        let applied =
            apply_studio_creation_edit_json(&fixture_json(), &studio_creation_edit_command_json())
                .unwrap();
        let projected: serde_json::Value = serde_json::from_slice(&projected).unwrap();
        let applied: serde_json::Value = serde_json::from_slice(&applied).unwrap();

        assert_eq!(applied["creationProjection"], projected);
        assert_eq!(projected["projectedDuration"], json!(2.4));
        assert_eq!(
            projected["entities"][0]["createdLifetime"]["end"],
            json!(2.4)
        );
        assert_eq!(projected["mutations"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn studio_creation_adapter_accepts_a_line() {
        let mut command: serde_json::Value =
            serde_json::from_slice(&studio_creation_edit_command_json()).unwrap();
        command["programs"].as_array_mut().unwrap().truncate(2);
        command["programs"][0]["operations"][0]["entity"]["dimensions"] = json!({});
        command["programs"][0]["operations"][0]["entity"]["kind"] = json!("line");
        let command = serde_json::to_vec(&command).unwrap();

        let response = apply_studio_creation_edit_json(&fixture_json(), &command).unwrap();
        let response: serde_json::Value = serde_json::from_slice(&response).unwrap();
        let bundle =
            parse_scene_ir_bundle_json_v1(&serde_json::to_vec(&response["bundle"]).unwrap())
                .unwrap();

        assert_eq!(
            response["creationProjection"]["entities"][0]["kind"],
            "line"
        );
        assert!(matches!(
            bundle
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == "tx:create/entity:rectangle")
                .unwrap()
                .geometry,
            SceneGeometryV1::Line { .. }
        ));
        assert!(bundle.scene.animation_channels.iter().any(|channel| {
            matches!(
                channel,
                AnimationChannelV1::AffineTransform {
                    entity_id,
                    keyframes,
                    ..
                } if entity_id == "tx:create/entity:rectangle"
                    && keyframes.first().is_some_and(|keyframe| {
                        (keyframe.value.m11 - 1.5).abs() < f64::EPSILON
                            && (keyframe.value.m22 - 1.5).abs() < f64::EPSILON
                    })
            )
        }));
    }

    #[test]
    fn studio_creation_adapter_rejects_invalid_ratio_and_stale_baseline() {
        let mut invalid_ratio: serde_json::Value =
            serde_json::from_slice(&studio_creation_edit_command_json()).unwrap();
        invalid_ratio["programs"][1]["operations"][0]["relativeFactor"] = json!(2.0);
        let error = apply_studio_creation_edit_json(
            &fixture_json(),
            &serde_json::to_vec(&invalid_ratio).unwrap(),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            SceneAuthoringAdapterError::StudioCreationEdit(
                ApplyStudioCreationEditError::Unsupported
            )
        ));

        let mut stale_baseline: serde_json::Value =
            serde_json::from_slice(&studio_creation_edit_command_json()).unwrap();
        stale_baseline["programs"][2]["operations"][0]["fromScale"] = json!(1.0);
        let error = apply_studio_creation_edit_json(
            &fixture_json(),
            &serde_json::to_vec(&stale_baseline).unwrap(),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            SceneAuthoringAdapterError::StudioCreationEdit(
                ApplyStudioCreationEditError::Unsupported
            )
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
    fn studio_timeline_adapter_forwards_literal_json_to_the_core() {
        let response = apply_studio_timeline_edit_json(
            &static_fixture_json(),
            &studio_timeline_edit_command_json(),
        )
        .unwrap();
        let bundle = parse_scene_ir_bundle_json_v1(&response).unwrap();

        assert!((bundle.scene.duration - 2.3).abs() < f64::EPSILON);
        assert!(
            bundle
                .scene
                .entities
                .iter()
                .all(|entity| { (entity.lifetimes[0].end - 2.3).abs() < f64::EPSILON })
        );
        assert_eq!(
            bundle.scene.provenance.last().unwrap().id,
            "studio-imported-timeline:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        );
        assert!(matches!(
            bundle.scene.source,
            SceneSourceV1::StudioEditProgram { revision_hash, .. }
                if revision_hash == "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        ));
    }

    #[test]
    fn studio_timeline_projection_adapter_returns_working_intervals_and_ordered_transforms() {
        let response =
            project_studio_timeline_json(&studio_timeline_projection_command_json()).unwrap();
        let projection: serde_json::Value = serde_json::from_slice(&response).unwrap();

        assert_eq!(projection["projectedDuration"], json!(2.3));
        assert_eq!(
            projection["programProjections"][0]["workingAnchor"],
            json!(0.5)
        );
        assert_eq!(
            projection["programProjections"][1]["workingAnchor"],
            json!(1.0)
        );
        assert_eq!(projection["transforms"][0]["kind"], json!("insert"));
        assert_eq!(projection["transforms"][1]["kind"], json!("remove"));
        assert_eq!(
            projection["transforms"][1]["waitReductions"],
            json!([{
                "operationId": "extend-scene-duration",
                "removedDuration": 0.2
            }])
        );
    }

    #[test]
    fn studio_timeline_adapter_rejects_unknown_fields_and_non_static_sources() {
        let mut unknown: serde_json::Value =
            serde_json::from_slice(&studio_timeline_edit_command_json()).unwrap();
        unknown["profile"] = json!("legacy");
        let error = apply_studio_timeline_edit_json(
            &static_fixture_json(),
            &serde_json::to_vec(&unknown).unwrap(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("unknown field `profile`"));

        let error =
            apply_studio_timeline_edit_json(&fixture_json(), &studio_timeline_edit_command_json())
                .unwrap_err();
        assert!(matches!(
            error,
            SceneAuthoringAdapterError::StudioTimelineEdit(
                ApplyStudioTimelineEditError::Unsupported
            )
        ));
    }

    #[test]
    fn motion_adapter_forwards_the_complete_command_to_the_core() {
        let response = apply_studio_motion_edit_json(
            &static_fixture_json(),
            &studio_motion_edit_command_json(),
        )
        .unwrap();
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
            let subpath = &path.subpaths[0];
            let segment = &subpath.segments[0];
            assert!((segment.control1.x - subpath.start.x - 2.0).abs() < 1e-12);
            assert!((segment.control1.y - subpath.start.y - 10.0 / 3.0).abs() < 1e-12);
            assert!((segment.control2.x - subpath.start.x - 4.0).abs() < 1e-12);
            assert!((segment.control2.y - subpath.start.y - 4.0).abs() < 1e-12);
            assert!((segment.end.x - subpath.start.x - 6.0).abs() < 1e-12);
            assert!((segment.end.y - subpath.start.y - 2.0).abs() < 1e-12);
            assert_eq!(
                provenance_id,
                "studio-motion:9999999999999999999999999999999999999999999999999999999999999999"
            );
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
    fn motion_projection_adapter_returns_expanded_studio_coordinate_facts() {
        let response =
            project_studio_motion_edit_json(&studio_motion_projection_command_json()).unwrap();
        let projection: serde_json::Value = serde_json::from_slice(&response).unwrap();

        assert_eq!(projection["insertions"].as_array().unwrap().len(), 1);
        assert_eq!(projection["motions"].as_array().unwrap().len(), 2);
        assert_eq!(
            projection["motions"][0]["from"],
            json!({ "x": 320.0, "y": 180.0 })
        );
        assert_eq!(
            projection["motions"][0]["to"],
            json!({ "x": 560.0, "y": 100.0 })
        );
        assert_eq!(
            projection["motions"][1]["targetEntityId"],
            json!("source:stroke")
        );
        assert_eq!(projection["projectedDuration"], json!(3.0));
    }

    #[test]
    fn math_tex_transform_adapter_forwards_the_complete_chain_to_the_core() {
        let response = apply_studio_math_tex_transform_edit_json(
            &static_math_tex_fixture_json(),
            &math_tex_transform_edit_command_json(),
        )
        .unwrap();
        let response: serde_json::Value = serde_json::from_slice(&response).unwrap();
        let bundle =
            parse_scene_ir_bundle_json_v1(&serde_json::to_vec(&response["bundle"]).unwrap())
                .unwrap();

        assert_eq!(bundle.scene.entities.len(), 3);
        assert_eq!(bundle.scene.animation_channels.len(), 3);
        assert_eq!(
            response["mathTexTransformProjection"],
            json!({
                "insertions": [{
                    "at": 0.25,
                    "duration": 1.0,
                    "transactionId": "math-tex-transform"
                }],
                "motions": [],
                "projectedDuration": 3.4,
                "replacements": [{
                    "content": {
                        "displayLines": ["B"],
                        "label": "middle",
                        "texParts": ["B"]
                    },
                    "interval": { "end": 0.75, "start": 0.25 },
                    "operationId": "transform-a-b",
                    "sourceEntityId": "source:formula",
                    "targetEntityId": "tx:math-tex-transform/entity:b",
                    "targetLifetime": { "end": 1.25, "start": 0.25 },
                    "targetType": "math-tex",
                    "transactionId": "math-tex-transform"
                }, {
                    "content": {
                        "displayLines": ["A"],
                        "label": "restored",
                        "texParts": ["A"]
                    },
                    "interval": { "end": 1.25, "start": 0.75 },
                    "operationId": "transform-b-a",
                    "sourceEntityId": "tx:math-tex-transform/entity:b",
                    "targetEntityId": "tx:math-tex-transform/entity:a-prime",
                    "targetLifetime": { "end": 3.4, "start": 0.75 },
                    "targetType": "math-tex",
                    "transactionId": "math-tex-transform"
                }]
            })
        );
        assert_eq!(
            response["persistentRemoveProjection"]["removals"],
            json!([])
        );
        assert!(response.get("staticRootProjection").is_none());
        assert!(bundle.scene.entities.iter().any(|entity| {
            entity.id == "tx:math-tex-transform/entity:a-prime"
                && matches!(entity.geometry, SceneGeometryV1::CubicPath { .. })
        }));
        assert!(matches!(
            bundle.scene.source,
            SceneSourceV1::StudioEditProgram { revision_hash, .. }
                if revision_hash == "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        ));
    }

    #[test]
    fn math_tex_transform_projector_forwards_logical_admission_to_the_core() {
        let response =
            project_studio_math_tex_transform_json(&math_tex_transform_projection_command_json())
                .unwrap();
        let response: serde_json::Value = serde_json::from_slice(&response).unwrap();

        assert_eq!(response["projectedDuration"], json!(3.4));
        assert_eq!(response["replacements"].as_array().unwrap().len(), 2);
        assert_eq!(
            response["replacements"][1]["targetLifetime"],
            json!({ "end": 3.4, "start": 0.75 })
        );
        assert_eq!(response["motions"], json!([]));
    }

    #[test]
    fn math_tex_transform_adapter_projects_and_applies_final_replacement_motion() {
        let projection = project_studio_math_tex_transform_json(
            &math_tex_transform_motion_projection_command_json(),
        )
        .unwrap();
        let projection: serde_json::Value = serde_json::from_slice(&projection).unwrap();
        assert_eq!(
            projection["motions"],
            json!([{
                "control": { "x": 880.0, "y": 290.0 },
                "controlOffset": { "x": 0.0, "y": -160.0 },
                "delta": { "x": 160.0, "y": 0.0 },
                "easing": "manim-smooth",
                "from": { "x": 800.0, "y": 450.0 },
                "interval": { "end": 1.75, "start": 1.5 },
                "operationId": "move-restored",
                "sourceInterval": { "end": 1.75, "start": 1.5 },
                "targetEntityId": "tx:math-tex-transform/entity:a-prime",
                "to": { "x": 960.0, "y": 450.0 },
                "transactionId": "math-tex-transform"
            }])
        );
        assert_eq!(projection["projectedDuration"], json!(3.9));

        let response = apply_studio_math_tex_transform_edit_json(
            &static_math_tex_fixture_json(),
            &math_tex_transform_motion_edit_command_json(),
        )
        .unwrap();
        let response: serde_json::Value = serde_json::from_slice(&response).unwrap();
        let bundle =
            parse_scene_ir_bundle_json_v1(&serde_json::to_vec(&response["bundle"]).unwrap())
                .unwrap();
        assert!(
            bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| matches!(
                    channel,
                    poietra_scene_ir::AnimationChannelV1::MotionPath { entity_id, .. }
                        if entity_id == "tx:math-tex-transform/entity:a-prime"
                ))
        );
    }

    #[test]
    fn math_tex_transform_projector_rejects_a_broken_chain() {
        let mut command: serde_json::Value =
            serde_json::from_slice(&math_tex_transform_projection_command_json()).unwrap();
        command["programs"][0]["operations"][1]["sourceEntityId"] = json!("source:formula");

        let error = project_studio_math_tex_transform_json(&serde_json::to_vec(&command).unwrap())
            .unwrap_err();

        assert!(error.to_string().contains("do not authorize"));
    }

    #[test]
    fn math_tex_content_adapter_returns_the_correlated_static_root_projection() {
        let response = apply_static_root_transform_edit_json(
            &static_math_tex_fixture_json(),
            &static_root_math_tex_content_command_json(),
        )
        .unwrap();
        let response: serde_json::Value = serde_json::from_slice(&response).unwrap();
        let bundle =
            parse_scene_ir_bundle_json_v1(&serde_json::to_vec(&response["bundle"]).unwrap())
                .unwrap();

        assert_eq!(
            response["persistentRemoveProjection"]["removals"],
            json!([])
        );
        assert_eq!(
            response["staticRootProjection"]["mutations"],
            json!([{
                "content": {
                    "displayLines": ["F = ma"],
                    "label": "force",
                    "texParts": ["F = ma"]
                },
                "entityId": "source:formula",
                "interval": { "end": 0.0, "start": 0.0 },
                "kind": "math-tex-content",
                "operationId": "set-formula-content",
                "transactionId": "set-formula-content"
            }])
        );
        assert_eq!(bundle.scene.entities.len(), 1);
        assert!(matches!(
            bundle.scene.source,
            SceneSourceV1::StudioEditProgram { revision_hash, .. }
                if revision_hash == "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        ));
    }

    #[test]
    fn static_root_adapter_atomically_rejects_a_mismatched_math_tex_content_outline() {
        let mut mismatch: serde_json::Value =
            serde_json::from_slice(&static_root_math_tex_content_command_json()).unwrap();
        mismatch["mathTexOutlines"][0]["texParts"] = json!(["mismatch"]);
        let error = apply_static_root_transform_edit_json(
            &static_math_tex_fixture_json(),
            &serde_json::to_vec(&mismatch).unwrap(),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            SceneAuthoringAdapterError::StaticRootTransformEdit(
                ApplyStaticRootTransformEditError::Unsupported
            )
        ));
    }

    #[test]
    fn motion_adapter_transports_multiple_programs_without_a_new_wire_version() {
        let mut command: serde_json::Value =
            serde_json::from_slice(&studio_motion_edit_command_json()).unwrap();
        command["programs"][0]["operations"][0]["targetEntityIds"] = json!(["source:later"]);
        command["programs"][0]["operations"][0]["interval"]["end"] = json!(1.0);
        let mut second = command["programs"][0].clone();
        second["operations"][0]["id"] = json!("create-motion-second");
        second["operations"][0]["delta"] = json!({ "x": 0.0, "y": -120.0 });
        second["operations"][0]["controlOffset"] = json!({ "x": 80.0, "y": 0.0 });
        second["operations"][0]["easing"] = json!("linear");
        second["operations"][0]["interval"]["end"] = json!(1.0);
        second["scheduleOrder"] = json!(["create-motion-second"]);
        second["transactionId"] = json!("create-motion-second");
        command["programs"].as_array_mut().unwrap().push(second);

        let response = apply_studio_motion_edit_json(
            &static_fixture_json(),
            &serde_json::to_vec(&command).unwrap(),
        )
        .unwrap();
        let bundle = parse_scene_ir_bundle_json_v1(&response).unwrap();
        let (keyframes, path) = bundle
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

        assert_eq!(command["version"], json!(1));
        assert_eq!(path.subpaths[0].segments.len(), 2);
        assert_eq!(
            keyframes
                .iter()
                .map(|keyframe| keyframe.at)
                .collect::<Vec<_>>(),
            vec![0.5, 1.0, 1.5]
        );
    }

    #[test]
    fn motion_adapter_rejects_unknown_stale_and_malformed_programs() {
        let mut unknown: serde_json::Value =
            serde_json::from_slice(&studio_motion_edit_command_json()).unwrap();
        unknown["profile"] = json!("generic-runtime-trace-v3");
        let error = apply_studio_motion_edit_json(
            &static_fixture_json(),
            &serde_json::to_vec(&unknown).unwrap(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("unknown field `profile`"));

        let mut stale: serde_json::Value =
            serde_json::from_slice(&studio_motion_edit_command_json()).unwrap();
        stale["expectedBaseRevision"] = json!("f".repeat(64));
        let error = apply_studio_motion_edit_json(
            &static_fixture_json(),
            &serde_json::to_vec(&stale).unwrap(),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            SceneAuthoringAdapterError::StudioMotionEdit(
                ApplyStudioMotionEditError::StaleBaseRevision
            )
        ));

        let mut malformed: serde_json::Value =
            serde_json::from_slice(&studio_motion_edit_command_json()).unwrap();
        malformed["programs"][0]["operations"][0]["dependsOn"] = json!(["missing"]);
        let error = apply_studio_motion_edit_json(
            &static_fixture_json(),
            &serde_json::to_vec(&malformed).unwrap(),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            SceneAuthoringAdapterError::StudioMotionEdit(ApplyStudioMotionEditError::Unsupported)
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
