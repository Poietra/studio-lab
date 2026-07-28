use std::collections::BTreeSet;

use poietra_eval::{EngineSessionV1, EvaluationError};
use poietra_scene_ir::{
    AnimationChannelV1, AssetManifestV1, FidelityV1, ProvenanceRecordV1, SceneCameraV1,
    SceneCapabilityV1, SceneEntityV1, SceneIrBundleV1, SceneSourceV1,
};
use serde::{Deserialize, Serialize};

pub(crate) const MAX_SCENE_DELTA_JSON_BYTES_V1: usize = 256 * 1024;
pub(crate) const MAX_SCENE_DELTA_ACK_JSON_BYTES_V1: usize = 128 * 1024;
const MAX_SCENE_DELTA_OPERATIONS_V1: usize = 256;
const MAX_SCENE_PROVENANCE_RECORDS_V1: usize = 20_000;

#[derive(Debug, thiserror::Error)]
pub(crate) enum SceneDeltaErrorV1 {
    #[error(
        "Scene delta contains {actual_bytes} bytes; maximum is {MAX_SCENE_DELTA_JSON_BYTES_V1}"
    )]
    InputTooLarge { actual_bytes: usize },
    #[error("invalid Scene delta JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid Scene delta: {0}")]
    Invalid(&'static str),
    #[error("Scene delta base revision is not installed")]
    StaleBaseRevision,
    #[error("Scene delta targets a different Scene ID")]
    SceneMismatch,
    #[error("Scene delta v1 accepts Studio Edit Program revisions only")]
    SourceUnsupported,
    #[error("Scene delta next revision does not match its source evidence")]
    NextRevisionMismatch,
    #[error("Scene delta operation conflicts with the retained Scene: {0}")]
    OperationConflict(String),
    #[error("Scene delta result failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
    #[error("Scene delta dirty acknowledgement could not be serialized: {0}")]
    DirtySerialization(serde_json::Error),
    #[error("Scene delta dirty acknowledgement exceeds its bounded response limit")]
    DirtyTooLarge,
}

impl SceneDeltaErrorV1 {
    #[cfg(test)]
    fn code(&self) -> &'static str {
        match self {
            Self::InputTooLarge { .. } => "delta-too-large",
            Self::Json(_) | Self::Invalid(_) => "invalid-delta",
            Self::StaleBaseRevision => "stale-base-revision",
            Self::SceneMismatch => "scene-mismatch",
            Self::SourceUnsupported => "source-unsupported",
            Self::NextRevisionMismatch => "next-revision-mismatch",
            Self::OperationConflict(_) => "operation-conflict",
            Self::ResultInvalid(_) | Self::DirtySerialization(_) | Self::DirtyTooLarge => {
                "result-invalid"
            }
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SceneDeltaDirtySetV1 {
    assets: bool,
    camera: bool,
    channel_ids: Vec<String>,
    entity_ids: Vec<String>,
    scene_metadata: bool,
}

impl SceneDeltaDirtySetV1 {
    fn new() -> Self {
        Self {
            assets: false,
            camera: false,
            channel_ids: Vec::new(),
            entity_ids: Vec::new(),
            scene_metadata: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum SceneDeltaSchemaV1 {
    #[serde(rename = "poietra.scene-delta")]
    SceneDelta,
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum ExpectedPresenceV1 {
    #[serde(rename = "absent")]
    Absent,
    #[serde(rename = "present")]
    Present,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum SceneDeltaOperationV1 {
    PutEntity {
        entity: SceneEntityV1,
        expected: ExpectedPresenceV1,
    },
    RemoveEntity {
        #[serde(rename = "entityId")]
        entity_id: String,
    },
    PutAnimationChannel {
        channel: AnimationChannelV1,
        expected: ExpectedPresenceV1,
    },
    RemoveAnimationChannel {
        #[serde(rename = "channelId")]
        channel_id: String,
    },
    UpdateScene {
        #[serde(default, deserialize_with = "deserialize_optional_non_null")]
        assets: Option<AssetManifestV1>,
        #[serde(default, deserialize_with = "deserialize_optional_non_null")]
        camera: Option<SceneCameraV1>,
        #[serde(default, deserialize_with = "deserialize_optional_non_null")]
        duration: Option<f64>,
        #[serde(default, deserialize_with = "deserialize_optional_non_null")]
        fidelity: Option<FidelityV1>,
        #[serde(default, deserialize_with = "deserialize_optional_non_null")]
        provenance: Option<Vec<ProvenanceRecordV1>>,
        #[serde(
            rename = "requiredCapabilities",
            default,
            deserialize_with = "deserialize_optional_non_null"
        )]
        required_capabilities: Option<Vec<SceneCapabilityV1>>,
    },
}

fn deserialize_optional_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SceneDeltaV1 {
    base_revision: String,
    next_revision: String,
    next_source: SceneSourceV1,
    operations: Vec<SceneDeltaOperationV1>,
    scene_id: String,
    #[serde(rename = "schema")]
    _schema: SceneDeltaSchemaV1,
    #[serde(rename = "version")]
    _version: poietra_scene_ir::ContractVersionV1,
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_source_identity(value: &str) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    value.encode_utf16().count() <= 240
        && first.is_ascii_alphanumeric()
        && bytes.all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'.' | b'_' | b':' | b'@' | b'/' | b'-' | b'#')
        })
}

fn operation_target(operation: &SceneDeltaOperationV1) -> String {
    match operation {
        SceneDeltaOperationV1::PutEntity { entity, .. } => format!("entity:{}", entity.id),
        SceneDeltaOperationV1::RemoveEntity { entity_id } => format!("entity:{entity_id}"),
        SceneDeltaOperationV1::PutAnimationChannel { channel, .. } => {
            format!("channel:{}", channel.id())
        }
        SceneDeltaOperationV1::RemoveAnimationChannel { channel_id } => {
            format!("channel:{channel_id}")
        }
        SceneDeltaOperationV1::UpdateScene { .. } => "scene:metadata".to_owned(),
    }
}

fn parse_scene_delta(json: &[u8]) -> Result<SceneDeltaV1, SceneDeltaErrorV1> {
    if json.len() > MAX_SCENE_DELTA_JSON_BYTES_V1 {
        return Err(SceneDeltaErrorV1::InputTooLarge {
            actual_bytes: json.len(),
        });
    }
    let delta: SceneDeltaV1 = serde_json::from_slice(json)?;
    if !valid_sha256(&delta.base_revision) || !valid_sha256(&delta.next_revision) {
        return Err(SceneDeltaErrorV1::Invalid(
            "baseRevision and nextRevision must be lower-case SHA-256 digests",
        ));
    }
    if delta.base_revision == delta.next_revision {
        return Err(SceneDeltaErrorV1::Invalid(
            "a Scene delta must advance the revision",
        ));
    }
    if !valid_source_identity(&delta.scene_id) {
        return Err(SceneDeltaErrorV1::Invalid(
            "sceneId must use the bounded portable identifier subset",
        ));
    }
    if delta.operations.is_empty() || delta.operations.len() > MAX_SCENE_DELTA_OPERATIONS_V1 {
        return Err(SceneDeltaErrorV1::Invalid(
            "operations must contain 1 through 256 entries",
        ));
    }
    let mut targets = BTreeSet::new();
    for operation in &delta.operations {
        let target = operation_target(operation);
        if !targets.insert(target) {
            return Err(SceneDeltaErrorV1::Invalid(
                "a Scene delta may target each entity, channel, or metadata record only once",
            ));
        }
        if let SceneDeltaOperationV1::UpdateScene {
            assets,
            camera,
            duration,
            fidelity,
            provenance,
            required_capabilities,
        } = operation
        {
            if assets.is_none()
                && camera.is_none()
                && duration.is_none()
                && fidelity.is_none()
                && provenance.is_none()
                && required_capabilities.is_none()
            {
                return Err(SceneDeltaErrorV1::Invalid(
                    "update-scene requires at least one changed field",
                ));
            }
            if duration.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                return Err(SceneDeltaErrorV1::Invalid(
                    "update-scene duration must be finite and positive",
                ));
            }
            if provenance.as_ref().is_some_and(|records| {
                records.is_empty() || records.len() > MAX_SCENE_PROVENANCE_RECORDS_V1
            }) {
                return Err(SceneDeltaErrorV1::Invalid(
                    "update-scene provenance must contain 1 through 20000 records",
                ));
            }
        }
    }
    Ok(delta)
}

fn put_by_id<T>(
    values: &mut Vec<T>,
    value: T,
    id: &str,
    expected: ExpectedPresenceV1,
    id_of: impl Fn(&T) -> &str,
    label: &str,
) -> Result<(), SceneDeltaErrorV1> {
    let index = values.iter().position(|entry| id_of(entry) == id);
    match (expected, index) {
        (ExpectedPresenceV1::Absent, None) => values.push(value),
        (ExpectedPresenceV1::Present, Some(index)) => values[index] = value,
        (ExpectedPresenceV1::Absent, Some(_)) => {
            return Err(SceneDeltaErrorV1::OperationConflict(format!(
                "{label} {id} already exists"
            )));
        }
        (ExpectedPresenceV1::Present, None) => {
            return Err(SceneDeltaErrorV1::OperationConflict(format!(
                "{label} {id} does not exist"
            )));
        }
    }
    Ok(())
}

fn remove_by_id<T>(
    values: &mut Vec<T>,
    id: &str,
    id_of: impl Fn(&T) -> &str,
    label: &str,
) -> Result<(), SceneDeltaErrorV1> {
    let Some(index) = values.iter().position(|entry| id_of(entry) == id) else {
        return Err(SceneDeltaErrorV1::OperationConflict(format!(
            "{label} {id} does not exist"
        )));
    };
    values.remove(index);
    Ok(())
}

fn apply_operation(
    candidate: &mut SceneIrBundleV1,
    operation: SceneDeltaOperationV1,
    dirty: &mut SceneDeltaDirtySetV1,
) -> Result<(), SceneDeltaErrorV1> {
    match operation {
        SceneDeltaOperationV1::PutEntity { entity, expected } => {
            let id = entity.id.clone();
            put_by_id(
                &mut candidate.scene.entities,
                entity,
                &id,
                expected,
                |entry| entry.id.as_str(),
                "Entity",
            )?;
            dirty.entity_ids.push(id);
            Ok(())
        }
        SceneDeltaOperationV1::RemoveEntity { entity_id } => {
            remove_by_id(
                &mut candidate.scene.entities,
                &entity_id,
                |entry| entry.id.as_str(),
                "Entity",
            )?;
            dirty.entity_ids.push(entity_id);
            Ok(())
        }
        SceneDeltaOperationV1::PutAnimationChannel { channel, expected } => {
            let id = channel.id().to_owned();
            put_by_id(
                &mut candidate.scene.animation_channels,
                channel,
                &id,
                expected,
                AnimationChannelV1::id,
                "Animation channel",
            )?;
            dirty.channel_ids.push(id);
            Ok(())
        }
        SceneDeltaOperationV1::RemoveAnimationChannel { channel_id } => {
            remove_by_id(
                &mut candidate.scene.animation_channels,
                &channel_id,
                AnimationChannelV1::id,
                "Animation channel",
            )?;
            dirty.channel_ids.push(channel_id);
            Ok(())
        }
        SceneDeltaOperationV1::UpdateScene {
            assets,
            camera,
            duration,
            fidelity,
            provenance,
            required_capabilities,
        } => {
            if let Some(assets) = assets {
                dirty.assets = true;
                candidate.scene.asset_manifest.manifest_digest = assets.manifest_digest.clone();
                candidate.scene.asset_manifest.manifest_id = assets.manifest_id.clone();
                candidate.assets = assets;
            }
            if let Some(camera) = camera {
                dirty.camera = true;
                candidate.scene.camera = camera;
            }
            if let Some(duration) = duration {
                dirty.scene_metadata = true;
                candidate.scene.duration = duration;
            }
            if let Some(fidelity) = fidelity {
                dirty.scene_metadata = true;
                candidate.scene.fidelity = fidelity;
            }
            if let Some(provenance) = provenance {
                dirty.scene_metadata = true;
                candidate.scene.provenance = provenance;
            }
            if let Some(required_capabilities) = required_capabilities {
                dirty.scene_metadata = true;
                candidate.scene.required_capabilities = required_capabilities;
            }
            Ok(())
        }
    }
}

pub(crate) fn apply_scene_delta_json(
    session: &mut EngineSessionV1,
    delta_json: &[u8],
    expected_base_revision: &str,
    expected_next_revision: &str,
) -> Result<Vec<u8>, SceneDeltaErrorV1> {
    let delta = parse_scene_delta(delta_json)?;
    if delta.base_revision != expected_base_revision
        || delta.next_revision != expected_next_revision
    {
        return Err(SceneDeltaErrorV1::Invalid(
            "delta revisions do not match the transport correlation",
        ));
    }
    if session.scene().scene_id != delta.scene_id {
        return Err(SceneDeltaErrorV1::SceneMismatch);
    }
    if session.scene().source.revision_hash() != delta.base_revision {
        return Err(SceneDeltaErrorV1::StaleBaseRevision);
    }
    let SceneSourceV1::StudioEditProgram { .. } = session.scene().source else {
        return Err(SceneDeltaErrorV1::SourceUnsupported);
    };
    let SceneSourceV1::StudioEditProgram {
        revision_hash: next_source_revision,
        ..
    } = &delta.next_source
    else {
        return Err(SceneDeltaErrorV1::SourceUnsupported);
    };
    if next_source_revision != &delta.next_revision {
        return Err(SceneDeltaErrorV1::NextRevisionMismatch);
    }

    let mut candidate = SceneIrBundleV1 {
        assets: session.assets().clone(),
        scene: session.scene().clone(),
    };
    let mut dirty = SceneDeltaDirtySetV1::new();
    for operation in delta.operations {
        apply_operation(&mut candidate, operation, &mut dirty)?;
    }
    candidate.scene.source = delta.next_source;

    // Serialize and bound the exact ACK before committing the candidate. This
    // keeps Scene/index revision and Worker revision in one transaction: no
    // post-swap serialization failure can strand them on different revisions.
    let dirty_json = serde_json::to_vec(&dirty).map_err(SceneDeltaErrorV1::DirtySerialization)?;
    if dirty_json.len() > MAX_SCENE_DELTA_ACK_JSON_BYTES_V1 {
        return Err(SceneDeltaErrorV1::DirtyTooLarge);
    }

    // EngineSessionV1 builds the entire validated replacement before swapping,
    // so every parse, operation, contract, digest, and retained-index failure
    // leaves the installed Scene and index untouched.
    session.replace_snapshot(candidate)?;
    Ok(dirty_json)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use poietra_scene_ir::{SceneIrBundleV1, parse_scene_ir_bundle_json_v1};
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};

    use super::*;

    fn fixture(name: &str) -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/engine-v1")
            .join(name);
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    fn base_bundle() -> SceneIrBundleV1 {
        let fixture = fixture("shared-circle-opacity.json");
        parse_scene_ir_bundle_json_v1(
            &serde_json::to_vec(&json!({
                "assets": fixture["assets"],
                "scene": fixture["scene"],
            }))
            .unwrap(),
        )
        .unwrap()
    }

    fn semantic_hash(session: &EngineSessionV1) -> String {
        let stats = session.retained_index_stats();
        let semantic = json!({
            "assets": session.assets(),
            "index": {
                "accountedBytes": stats.accounted_bytes(),
                "buildCount": stats.build_count(),
                "channelEntries": stats.channel_entries(),
                "entityEntries": stats.entity_entries(),
                "hierarchyEntries": stats.hierarchy_entries(),
                "paintOrderEntries": stats.paint_order_entries(),
            },
            "scene": session.scene(),
        });
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&semantic).unwrap())
        )
    }

    fn apply_overrides(delta: &mut Value, overrides: &Value) {
        let target = delta.as_object_mut().unwrap();
        for (key, value) in overrides.as_object().into_iter().flatten() {
            target.insert(key.clone(), value.clone());
        }
    }

    #[test]
    fn shared_single_entity_delta_is_atomic_bounded_and_reports_only_its_dirty_target() {
        let shared = fixture("shared-single-entity-delta.json");
        assert_eq!(
            shared["limits"]["deltaJsonBytes"],
            MAX_SCENE_DELTA_JSON_BYTES_V1
        );
        assert_eq!(
            shared["limits"]["dirtyAckJsonBytes"],
            MAX_SCENE_DELTA_ACK_JSON_BYTES_V1
        );
        assert_eq!(
            shared["limits"]["operations"],
            MAX_SCENE_DELTA_OPERATIONS_V1
        );
        let delta_json = serde_json::to_vec(&shared["delta"]).unwrap();
        let snapshot_json = serde_json::to_vec(&base_bundle()).unwrap();
        assert!(delta_json.len() * 2 < snapshot_json.len());
        assert!(delta_json.len() <= MAX_SCENE_DELTA_JSON_BYTES_V1);

        let mut session = EngineSessionV1::new(base_bundle()).unwrap();
        let dirty_json = apply_scene_delta_json(
            &mut session,
            &delta_json,
            shared["delta"]["baseRevision"].as_str().unwrap(),
            shared["delta"]["nextRevision"].as_str().unwrap(),
        )
        .unwrap();
        assert!(dirty_json.len() <= MAX_SCENE_DELTA_ACK_JSON_BYTES_V1);
        let dirty: SceneDeltaDirtySetV1 = serde_json::from_slice(&dirty_json).unwrap();

        assert_eq!(dirty.entity_ids, ["earlier"]);
        assert!(dirty.channel_ids.is_empty());
        assert!(!dirty.assets);
        assert!(!dirty.camera);
        assert!(!dirty.scene_metadata);
        assert_eq!(
            session.scene().source.revision_hash(),
            shared["expected"]["revision"]
        );
        let entity = session
            .scene()
            .entities
            .iter()
            .find(|entity| entity.id == shared["expected"]["entityId"])
            .unwrap();
        assert!(
            (entity.transform.tx - shared["expected"]["tx"].as_f64().unwrap()).abs() < f64::EPSILON
        );
        assert_eq!(session.retained_index_stats().build_count(), 2);
    }

    #[test]
    fn shared_reject_codes_preserve_scene_revision_and_index_semantic_hash() {
        let shared = fixture("shared-single-entity-delta.json");
        for case in shared["rejectCases"].as_array().unwrap() {
            let mut session = EngineSessionV1::new(base_bundle()).unwrap();
            let before_hash = semantic_hash(&session);
            let before_revision = session.scene().source.revision_hash().to_owned();
            let before_stats = session.retained_index_stats();

            let (delta_json, expected_base, expected_next) =
                if let Some(size) = case["oversizedBytes"].as_u64() {
                    (
                        vec![b' '; usize::try_from(size).unwrap()],
                        "a".repeat(64),
                        "b".repeat(64),
                    )
                } else {
                    let mut delta = shared["delta"].clone();
                    apply_overrides(&mut delta, &case["overrides"]);
                    let expected_base = delta["baseRevision"].as_str().unwrap().to_owned();
                    let expected_next = delta["nextRevision"].as_str().unwrap().to_owned();
                    (
                        serde_json::to_vec(&delta).unwrap(),
                        expected_base,
                        expected_next,
                    )
                };
            let error =
                apply_scene_delta_json(&mut session, &delta_json, &expected_base, &expected_next)
                    .unwrap_err();
            assert_eq!(
                error.code(),
                case["expectedCode"].as_str().unwrap(),
                "shared rejection {}",
                case["id"]
            );
            assert_eq!(
                semantic_hash(&session),
                before_hash,
                "shared rejection {}",
                case["id"]
            );
            assert_eq!(session.scene().source.revision_hash(), before_revision);
            assert_eq!(session.retained_index_stats(), before_stats);
        }
    }

    #[test]
    fn dirty_set_covers_channel_camera_asset_and_metadata_targets() {
        let shared = fixture("shared-single-entity-delta.json");
        let base = base_bundle();
        let mut delta = shared["delta"].clone();
        let channel = base.scene.animation_channels[0].clone();
        let mut camera = base.scene.camera.clone();
        camera.view.center.x = 1.0;
        let mut assets = serde_json::to_value(&base.assets).unwrap();
        // The unchanged, valid manifest still proves the asset dirty axis was
        // explicitly targeted without inventing a second fixture digest.
        let operations = vec![
            json!({ "channel": channel, "expected": "present", "kind": "put-animation-channel" }),
            json!({
                "assets": assets.take(),
                "camera": camera,
                "duration": 3,
                "kind": "update-scene"
            }),
        ];
        delta["operations"] = Value::Array(operations);
        let mut session = EngineSessionV1::new(base).unwrap();
        let dirty_json = apply_scene_delta_json(
            &mut session,
            &serde_json::to_vec(&delta).unwrap(),
            delta["baseRevision"].as_str().unwrap(),
            delta["nextRevision"].as_str().unwrap(),
        )
        .unwrap();
        let dirty: SceneDeltaDirtySetV1 = serde_json::from_slice(&dirty_json).unwrap();
        assert!(dirty.assets);
        assert!(dirty.camera);
        assert!(dirty.scene_metadata);
        assert_eq!(dirty.channel_ids.len(), 1);
        assert!(dirty.entity_ids.is_empty());
    }
}
