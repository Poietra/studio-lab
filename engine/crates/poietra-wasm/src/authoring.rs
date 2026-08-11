use poietra_eval::{
    EngineSessionV1, EvaluationError, RotateSceneEntityCommandV1, RotateSceneEntityErrorV1,
};
use poietra_scene_ir::{
    ContractJsonError, ContractVersionV1, PointV1, ProvenanceRecordV1,
    parse_scene_ir_bundle_json_v1,
};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

const MAX_ROTATE_SCENE_ENTITY_COMMAND_JSON_BYTES_V1: usize = 64 * 1024;

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

#[derive(Debug, thiserror::Error)]
enum RotateSceneEntityAdapterErrorV1 {
    #[error(
        "rotation command contains {actual_bytes} bytes; maximum is {MAX_ROTATE_SCENE_ENTITY_COMMAND_JSON_BYTES_V1}"
    )]
    CommandTooLarge { actual_bytes: usize },
    #[error("invalid rotation command JSON: {0}")]
    CommandJson(#[from] serde_json::Error),
    #[error("invalid rotation snapshot: {0}")]
    Snapshot(#[from] ContractJsonError),
    #[error("the rotation snapshot could not create an Engine session: {0}")]
    Session(#[from] EvaluationError),
    #[error(transparent)]
    Command(#[from] RotateSceneEntityErrorV1),
    #[error("the rotated Scene bundle could not be serialized: {0}")]
    ResponseJson(serde_json::Error),
    #[error("the rotated Scene bundle exceeds the v1 contract JSON limit")]
    ResponseTooLarge,
}

fn rotate_scene_entity_json_v1(
    snapshot_json: &[u8],
    command_json: &[u8],
) -> Result<Vec<u8>, RotateSceneEntityAdapterErrorV1> {
    if command_json.len() > MAX_ROTATE_SCENE_ENTITY_COMMAND_JSON_BYTES_V1 {
        return Err(RotateSceneEntityAdapterErrorV1::CommandTooLarge {
            actual_bytes: command_json.len(),
        });
    }
    let bundle = parse_scene_ir_bundle_json_v1(snapshot_json)?;
    let command: RotateSceneEntityCommandJsonV1 = serde_json::from_slice(command_json)?;
    let mut session = EngineSessionV1::new(bundle)?;
    let result = session.rotate_scene_entity_v1(command.into())?;
    let response =
        serde_json::to_vec(&result).map_err(RotateSceneEntityAdapterErrorV1::ResponseJson)?;
    if response.len() > poietra_scene_ir::MAX_CONTRACT_JSON_BYTES_V1 {
        return Err(RotateSceneEntityAdapterErrorV1::ResponseTooLarge);
    }
    Ok(response)
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

    use poietra_scene_ir::{SceneSourceV1, parse_scene_ir_bundle_json_v1};
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
}
