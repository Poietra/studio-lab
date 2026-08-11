use poietra_eval::{
    EngineSessionV1, EvaluationError, MoveSceneEntityCommandV1, MoveSceneEntityErrorV1,
    RotateSceneEntityCommandV1, RotateSceneEntityErrorV1,
};
use poietra_scene_ir::{
    ContractJsonError, ContractVersionV1, PointV1, ProvenanceRecordV1, SceneIrBundleV1,
    parse_scene_ir_bundle_json_v1,
};
use serde::{Deserialize, de::DeserializeOwned};
use wasm_bindgen::prelude::*;

const MAX_SCENE_AUTHORING_COMMAND_JSON_BYTES_V1: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Deserialize)]
enum MoveSceneEntitySchemaV1 {
    #[serde(rename = "poietra.move-scene-entity")]
    MoveSceneEntity,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoveSceneEntityCommandJsonV1 {
    delta: PointV1,
    entity_id: String,
    expected_base_revision: String,
    next_revision: String,
    provenance: ProvenanceRecordV1,
    #[serde(rename = "schema")]
    _schema: MoveSceneEntitySchemaV1,
    #[serde(rename = "version")]
    _version: ContractVersionV1,
}

impl From<MoveSceneEntityCommandJsonV1> for MoveSceneEntityCommandV1 {
    fn from(value: MoveSceneEntityCommandJsonV1) -> Self {
        Self {
            delta: value.delta,
            entity_id: value.entity_id,
            expected_base_revision: value.expected_base_revision,
            next_revision: value.next_revision,
            provenance: value.provenance,
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum SceneAuthoringAdapterErrorV1 {
    #[error(
        "{command} command contains {actual_bytes} bytes; maximum is {MAX_SCENE_AUTHORING_COMMAND_JSON_BYTES_V1}"
    )]
    CommandTooLarge {
        command: &'static str,
        actual_bytes: usize,
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
    MoveCommand(#[from] MoveSceneEntityErrorV1),
    #[error(transparent)]
    RotationCommand(#[from] RotateSceneEntityErrorV1),
    #[error("the authored Scene bundle could not be serialized: {0}")]
    ResponseJson(serde_json::Error),
    #[error(
        "the authored Scene bundle contains {actual_bytes} bytes; maximum is {}",
        poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1
    )]
    ResponseTooLarge { actual_bytes: usize },
}

fn parse_scene_authoring_command_v1<T: DeserializeOwned>(
    command: &'static str,
    command_json: &[u8],
) -> Result<T, SceneAuthoringAdapterErrorV1> {
    if command_json.len() > MAX_SCENE_AUTHORING_COMMAND_JSON_BYTES_V1 {
        return Err(SceneAuthoringAdapterErrorV1::CommandTooLarge {
            command,
            actual_bytes: command_json.len(),
        });
    }
    serde_json::from_slice(command_json)
        .map_err(|source| SceneAuthoringAdapterErrorV1::CommandJson { command, source })
}

fn scene_authoring_session_v1(
    snapshot_json: &[u8],
) -> Result<EngineSessionV1, SceneAuthoringAdapterErrorV1> {
    let bundle = parse_scene_ir_bundle_json_v1(snapshot_json)?;
    Ok(EngineSessionV1::new(bundle)?)
}

fn scene_authoring_response_v1(
    bundle: &SceneIrBundleV1,
) -> Result<Vec<u8>, SceneAuthoringAdapterErrorV1> {
    let response =
        serde_json::to_vec(bundle).map_err(SceneAuthoringAdapterErrorV1::ResponseJson)?;
    if response.len() > poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1 {
        return Err(SceneAuthoringAdapterErrorV1::ResponseTooLarge {
            actual_bytes: response.len(),
        });
    }
    Ok(response)
}

fn move_scene_entity_json_v1(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterErrorV1> {
    let command: MoveSceneEntityCommandJsonV1 =
        parse_scene_authoring_command_v1("move", command_json)?;
    let mut session = scene_authoring_session_v1(snapshot_json)?;
    let result = session.move_scene_entity_v1(command.into())?;
    scene_authoring_response_v1(&result)
}

/// Applies one concrete Scene translation through the shared native/WASM core.
///
/// # Errors
///
/// Returns a JavaScript error for an invalid snapshot, command, or moved result.
#[wasm_bindgen(js_name = moveSceneEntityV1)]
pub fn move_scene_entity_v1(snapshot_json: &[u8], command_json: &[u8]) -> Result<Vec<u8>, JsValue> {
    move_scene_entity_json_v1(snapshot_json, command_json)
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

impl From<RotateSceneEntityCommandJsonV1> for RotateSceneEntityCommandV1 {
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

fn rotate_scene_entity_json_v1(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, SceneAuthoringAdapterErrorV1> {
    let command: RotateSceneEntityCommandJsonV1 =
        parse_scene_authoring_command_v1("rotation", command_json)?;
    let mut session = scene_authoring_session_v1(snapshot_json)?;
    let result = session.rotate_scene_entity_v1(command.into())?;
    scene_authoring_response_v1(&result)
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
    rotate_scene_entity_json_v1(snapshot_json, command_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use poietra_scene_ir::{SceneGeometryV1, SceneSourceV1, parse_scene_ir_bundle_json_v1};
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

    fn move_command_json() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "delta": { "x": 2.5, "y": -1.5 },
            "entityId": "later",
            "expectedBaseRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "nextRevision": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "provenance": {
                "evidence": ["WASM adapter move test"],
                "id": "wasm-move",
                "origin": "studio-edit-program"
            },
            "schema": "poietra.move-scene-entity",
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
    fn move_adapter_returns_the_complete_core_bundle() {
        let response = move_scene_entity_json_v1(&fixture_json(), &move_command_json()).unwrap();
        let bundle = parse_scene_ir_bundle_json_v1(&response).unwrap();
        let moved = bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();

        assert!((moved.transform.tx - 2.5).abs() < 1e-12);
        assert!((moved.transform.ty + 1.5).abs() < 1e-12);
        assert_eq!(moved.provenance_id, "wasm-move");
        assert!(matches!(
            bundle.scene.source,
            SceneSourceV1::StudioEditProgram { revision_hash, .. }
                if revision_hash == "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        ));
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
            "schema": "poietra.move-scene-entity",
            "version": 1
        }))
        .unwrap();
        let (before, camera_width, camera_height) =
            interaction_clip_bounds(&snapshot, &root_id, 0.5);
        let moved_snapshot = move_scene_entity_json_v1(&snapshot, &command).unwrap();
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
    fn move_adapter_rejects_unknown_command_fields() {
        let mut command: serde_json::Value = serde_json::from_slice(&move_command_json()).unwrap();
        command["profile"] = json!("generic-runtime-trace-v3");

        let error =
            move_scene_entity_json_v1(&fixture_json(), &serde_json::to_vec(&command).unwrap())
                .unwrap_err();

        assert!(error.to_string().contains("unknown field `profile`"));
    }

    #[test]
    fn move_adapter_rejects_oversized_commands_before_parsing() {
        let command = vec![b' '; MAX_SCENE_AUTHORING_COMMAND_JSON_BYTES_V1 + 1];
        let error = move_scene_entity_json_v1(&fixture_json(), &command).unwrap_err();

        assert!(matches!(
            error,
            SceneAuthoringAdapterErrorV1::CommandTooLarge {
                command: "move",
                actual_bytes
            } if actual_bytes == MAX_SCENE_AUTHORING_COMMAND_JSON_BYTES_V1 + 1
        ));
    }

    #[test]
    fn adapter_parses_the_wire_command_and_returns_the_complete_bundle() {
        let response = rotate_scene_entity_json_v1(&fixture_json(), &command_json()).unwrap();
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
    fn adapter_rejects_unknown_command_fields() {
        let mut command: serde_json::Value = serde_json::from_slice(&command_json()).unwrap();
        command["profile"] = json!("generic-runtime-trace-v3");

        let error =
            rotate_scene_entity_json_v1(&fixture_json(), &serde_json::to_vec(&command).unwrap())
                .unwrap_err();

        assert!(error.to_string().contains("unknown field `profile`"));
    }

    #[test]
    fn rotation_adapter_rejects_oversized_commands_before_parsing() {
        let command = vec![b' '; MAX_SCENE_AUTHORING_COMMAND_JSON_BYTES_V1 + 1];
        let error = rotate_scene_entity_json_v1(&fixture_json(), &command).unwrap_err();

        assert!(matches!(
            error,
            SceneAuthoringAdapterErrorV1::CommandTooLarge {
                command: "rotation",
                actual_bytes
            } if actual_bytes == MAX_SCENE_AUTHORING_COMMAND_JSON_BYTES_V1 + 1
        ));
    }

    #[test]
    fn shared_response_serializer_rejects_oversized_bundles() {
        let mut bundle = parse_scene_ir_bundle_json_v1(&fixture_json()).unwrap();
        bundle.scene.provenance[0].evidence =
            vec!["x".repeat(poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1)];

        let error = scene_authoring_response_v1(&bundle).unwrap_err();

        assert!(matches!(
            error,
            SceneAuthoringAdapterErrorV1::ResponseTooLarge { actual_bytes }
                if actual_bytes > poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1
        ));
    }
}
