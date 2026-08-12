use poietra_eval::{
    CreateSceneEntitiesCommand, CreateSceneEntitiesError, CreateSceneEntity,
    CreateSceneEntityFadeIn, CreateSceneEntityGeometry, CreateSceneEntityInstantTransform,
    EditSceneTimelineCommand, EditSceneTimelineError, EngineSessionV1, EvaluationError,
    RotateSceneEntityCommand, RotateSceneEntityError, ScaleAboutPivot, SceneTimelineEdit,
    SceneTimelineInsertion, SetSubtreeVectorPaintAlphaCommand, SetSubtreeVectorPaintAlphaError,
    TransformSceneEntityCommand, TransformSceneEntityError,
};
use poietra_scene_ir::{
    ContractJsonError, ContractVersionV1, CubicPathV1, IntervalV1, PointV1, ProvenanceRecordV1,
    SceneIrBundleV1, parse_scene_ir_bundle_json_v1,
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
enum CreateSceneEntitiesSchemaV1 {
    #[serde(rename = "poietra.create-scene-entities")]
    CreateSceneEntities,
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum EditSceneTimelineSchemaV1 {
    #[serde(rename = "poietra.edit-scene-timeline")]
    EditSceneTimeline,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum CreateSceneEntityGeometryJsonV1 {
    #[serde(rename = "circle")]
    Circle { radius: f64 },
    #[serde(rename = "rectangle")]
    Rectangle { height: f64, width: f64 },
    #[serde(rename = "mathtex")]
    MathTex { path: CubicPathV1 },
}

impl From<CreateSceneEntityGeometryJsonV1> for CreateSceneEntityGeometry {
    fn from(value: CreateSceneEntityGeometryJsonV1) -> Self {
        match value {
            CreateSceneEntityGeometryJsonV1::Circle { radius } => Self::Circle { radius },
            CreateSceneEntityGeometryJsonV1::Rectangle { height, width } => {
                Self::Rectangle { height, width }
            }
            CreateSceneEntityGeometryJsonV1::MathTex { path } => Self::MathTex { path },
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateSceneEntityFadeInJsonV1 {
    end: f64,
}

impl From<CreateSceneEntityFadeInJsonV1> for CreateSceneEntityFadeIn {
    fn from(value: CreateSceneEntityFadeInJsonV1) -> Self {
        Self { end: value.end }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateSceneEntityJsonV1 {
    fade_in: Option<CreateSceneEntityFadeInJsonV1>,
    geometry: CreateSceneEntityGeometryJsonV1,
    id: String,
    lifetime: IntervalV1,
    position: PointV1,
    scale: f64,
    instant_transform: Option<CreateSceneEntityInstantTransformJsonV1>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateSceneEntityInstantTransformJsonV1 {
    at: f64,
    position: PointV1,
    scale_x: f64,
    scale_y: f64,
}

impl From<CreateSceneEntityInstantTransformJsonV1> for CreateSceneEntityInstantTransform {
    fn from(value: CreateSceneEntityInstantTransformJsonV1) -> Self {
        Self {
            at: value.at,
            position: value.position,
            scale_x: value.scale_x,
            scale_y: value.scale_y,
        }
    }
}

impl From<CreateSceneEntityJsonV1> for CreateSceneEntity {
    fn from(value: CreateSceneEntityJsonV1) -> Self {
        Self {
            fade_in: value.fade_in.map(Into::into),
            geometry: value.geometry.into(),
            id: value.id,
            lifetime: value.lifetime,
            position: value.position,
            scale: value.scale,
            instant_transform: value.instant_transform.map(Into::into),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SceneTimelineInsertionJsonV1 {
    at: f64,
    duration: f64,
}

impl From<SceneTimelineInsertionJsonV1> for SceneTimelineInsertion {
    fn from(value: SceneTimelineInsertionJsonV1) -> Self {
        Self {
            at: value.at,
            duration: value.duration,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateSceneEntitiesCommandJsonV1 {
    entities: Vec<CreateSceneEntityJsonV1>,
    expected_base_revision: String,
    next_revision: String,
    provenance: ProvenanceRecordV1,
    #[serde(rename = "schema")]
    _schema: CreateSceneEntitiesSchemaV1,
    timeline_insertions: Vec<SceneTimelineInsertionJsonV1>,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum SceneTimelineEditJsonV1 {
    #[serde(rename = "insert-wait")]
    InsertWait { at: f64, duration: f64 },
    #[serde(rename = "trim-scene-duration")]
    TrimSceneDuration {
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
                removed_duration,
                target_duration,
            } => Self::TrimSceneDuration {
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

impl From<CreateSceneEntitiesCommandJsonV1> for CreateSceneEntitiesCommand {
    fn from(value: CreateSceneEntitiesCommandJsonV1) -> Self {
        Self {
            entities: value.entities.into_iter().map(Into::into).collect(),
            expected_base_revision: value.expected_base_revision,
            next_revision: value.next_revision,
            provenance: value.provenance,
            timeline_insertions: value
                .timeline_insertions
                .into_iter()
                .map(Into::into)
                .collect(),
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
    delta: PointV1,
    entity_id: String,
    expected_base_revision: String,
    next_revision: String,
    provenance: ProvenanceRecordV1,
    #[serde(rename = "schema")]
    _schema: TransformSceneEntitySchemaV1,
    scale: Option<ScaleAboutPivotJsonV1>,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
}

impl From<TransformSceneEntityCommandJsonV1> for TransformSceneEntityCommand {
    fn from(value: TransformSceneEntityCommandJsonV1) -> Self {
        Self {
            delta: value.delta,
            entity_id: value.entity_id,
            expected_base_revision: value.expected_base_revision,
            next_revision: value.next_revision,
            provenance: value.provenance,
            scale: value.scale.map(Into::into),
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
    CreateCommand(#[from] CreateSceneEntitiesError),
    #[error(transparent)]
    TimelineCommand(#[from] EditSceneTimelineError),
    #[error(transparent)]
    RotationCommand(#[from] RotateSceneEntityError),
    #[error(transparent)]
    TransformCommand(#[from] TransformSceneEntityError),
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

fn create_scene_entities_json(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterError> {
    let command: CreateSceneEntitiesCommandJsonV1 = parse_scene_authoring_command_with_limit(
        "create entities",
        command_json,
        poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1,
    )?;
    let mut session = scene_authoring_session(snapshot_json)?;
    let result = session.create_scene_entities(command.into())?;
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

/// Creates supported Studio entities through the shared core.
///
/// # Errors
///
/// Returns a JavaScript error for an invalid snapshot, command, or created result.
#[wasm_bindgen(js_name = createSceneEntitiesV1)]
pub fn create_scene_entities_v1(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, JsValue> {
    create_scene_entities_json(snapshot_json, command_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Applies one atomic translation and optional positive axis scale through the shared core.
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

    fn create_entities_command_json() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "entities": [{
                "fadeIn": { "end": 0.9 },
                "geometry": { "height": 2.0, "kind": "rectangle", "width": 4.0 },
                "id": "studio-created-rectangle",
                "lifetime": { "end": 2.4, "start": 0.5 },
                "position": { "x": 2.0, "y": 0.0 },
                "scale": 1.0,
                "instantTransform": {
                    "at": 1.25,
                    "position": { "x": 3.0, "y": 1.0 },
                    "scaleX": 1.5,
                    "scaleY": 0.75
                }
            }],
            "expectedBaseRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "nextRevision": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "provenance": {
                "evidence": ["WASM adapter entity creation test"],
                "id": "wasm-create-entities",
                "origin": "studio-edit-program"
            },
            "schema": "poietra.create-scene-entities",
            "timelineInsertions": [
                { "at": 0.5, "duration": 0.2 },
                { "at": 0.7, "duration": 0.2 }
            ],
            "version": 1
        }))
        .unwrap()
    }

    fn edit_timeline_command_json() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "edits": [
                { "at": 0.5, "duration": 0.5, "kind": "insert-wait" },
                { "kind": "trim-scene-duration", "removedDuration": 0.2, "targetDuration": 2.3 }
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
            "delta": { "x": 2.5, "y": -1.5 },
            "entityId": root_id,
            "expectedBaseRevision": bundle.scene.source.revision_hash(),
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
            "delta": { "x": 0.0, "y": 0.0 },
            "entityId": root_id,
            "expectedBaseRevision": bundle.scene.source.revision_hash(),
            "nextRevision": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "provenance": {
                "evidence": ["WASM adapter real top-level group axis scale test"],
                "id": "wasm-real-group-axis-scale",
                "origin": "studio-edit-program"
            },
            "schema": "poietra.transform-scene-entity",
            "scale": {
                "pivot": { "x": 1.0, "y": -0.5 },
                "xFactor": 0.5,
                "yFactor": 0.75
            },
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
    fn create_entities_adapter_forwards_the_strict_command_to_the_core() {
        let snapshot = fixture_json();
        let before = parse_scene_ir_bundle_json_v1(&snapshot).unwrap();
        let response =
            create_scene_entities_json(&snapshot, &create_entities_command_json()).unwrap();
        let bundle = parse_scene_ir_bundle_json_v1(&response).unwrap();
        let created = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "studio-created-rectangle")
            .unwrap();

        assert_eq!(bundle.assets, before.assets);
        assert!((bundle.scene.duration - 2.4).abs() < 1e-12);
        assert_eq!(created.provenance_id, "wasm-create-entities");
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
        assert!(
            bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| matches!(
                    channel,
                    AnimationChannelV1::AffineTransform {
                        entity_id,
                        keyframes,
                        ..
                    } if entity_id == "studio-created-rectangle"
                        && (keyframes[0].at - 1.25).abs() < f64::EPSILON
                        && (keyframes[0].value.m11 - 1.5).abs() < f64::EPSILON
                        && (keyframes[0].value.m22 - 0.75).abs() < f64::EPSILON
                ))
        );
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
    fn create_entities_adapter_rejects_malformed_bounded_json_and_core_errors() {
        let mut unknown: serde_json::Value =
            serde_json::from_slice(&create_entities_command_json()).unwrap();
        unknown["duration"] = json!(2.4);
        let error =
            create_scene_entities_json(&fixture_json(), &serde_json::to_vec(&unknown).unwrap())
                .unwrap_err();
        assert!(error.to_string().contains("unknown field `duration`"));

        let mut stale: serde_json::Value =
            serde_json::from_slice(&create_entities_command_json()).unwrap();
        stale["expectedBaseRevision"] = json!("f".repeat(64));
        let error =
            create_scene_entities_json(&fixture_json(), &serde_json::to_vec(&stale).unwrap())
                .unwrap_err();
        assert!(matches!(
            error,
            SceneAuthoringAdapterError::CreateCommand(CreateSceneEntitiesError::StaleBaseRevision)
        ));

        let oversized = vec![b' '; poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1 + 1];
        let error = create_scene_entities_json(&fixture_json(), &oversized).unwrap_err();
        assert!(matches!(
            error,
            SceneAuthoringAdapterError::CommandTooLarge {
                command: "create entities",
                actual_bytes,
                maximum_bytes: poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1,
            } if actual_bytes == poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1 + 1
        ));
    }

    #[test]
    fn transform_adapter_rejects_unknown_and_oversized_commands() {
        let mut command = json!({
            "delta": { "x": 1.0, "y": 0.0 },
            "entityId": "later",
            "expectedBaseRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
