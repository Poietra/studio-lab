use std::fs;
use std::path::PathBuf;

use poietra_eval::{
    CompileEngineFrameOptionsV1, EngineSessionV1, SampleEngineSessionOptionsV1,
    compile_render_packet_v1,
};
use poietra_render_wgpu::{PreparedGeometryCacheV1, prepare_frame_v1, prepare_frame_with_cache_v1};
use poietra_scene_ir::{
    RenderDrawV1, SceneIrBundleV1, SceneSourceV1, SnapshotProfileVersionV1, StrokeJoinV1,
};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const FIXTURE_ID: &str = "eng-v1-real-line-joints-v10";
const SNAPSHOT_HASH: &str = "53fd284f9fd30f8223f90dfc9c291d571bab25d61b55170d5e57cf346e1b2827";
const SOURCE_SHA256: &str = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const FAST_MANIM_COMMIT: &str = "29d21a2bd213df8ffeed0454278aa86289d190b8";
const SEMANTIC_NUMBER_SCALE: f64 = 1_000_000_000.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureV10 {
    assets: Value,
    id: String,
    producer_reference: ProducerReferenceV10,
    samples: Vec<SampleV10>,
    scene: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProducerReferenceV10 {
    engine_commit: String,
    fast_manim_commit: String,
    kind: String,
    snapshot_hash: String,
    source_path: String,
    source_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SampleV10 {
    expected: ExpectedV10,
    id: String,
    packet_id: String,
    sample_time: f64,
    viewport: poietra_scene_ir::ViewportV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedV10 {
    semantic_digest: String,
}

fn fixture() -> (FixtureV10, SceneIrBundleV1) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/engine-v1/real-line-joints-v10.json");
    let fixture: FixtureV10 = serde_json::from_slice(
        &fs::read(path).expect("the sealed LineJoints V10 fixture must be readable"),
    )
    .expect("the sealed LineJoints V10 fixture must match its envelope");
    let bundle = serde_json::from_value(serde_json::json!({
        "assets": fixture.assets,
        "scene": fixture.scene,
    }))
    .expect("the sealed LineJoints V10 bundle must match Scene IR");
    (fixture, bundle)
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "finite fixture coordinates are rounded into a bounded semantic digest"
)]
fn normalize_semantic_numbers(value: &mut Value) {
    match value {
        Value::Number(number) => {
            let scaled = (number
                .as_f64()
                .expect("frame semantics must contain finite JSON numbers")
                * SEMANTIC_NUMBER_SCALE)
                .round() as i64;
            *number = scaled.into();
        }
        Value::Array(entries) => entries.iter_mut().for_each(normalize_semantic_numbers),
        Value::Object(entries) => entries.values_mut().for_each(normalize_semantic_numbers),
        Value::Bool(_) | Value::Null | Value::String(_) => {}
    }
}

fn semantic_digest(packet: &poietra_scene_ir::RenderPacketV1) -> String {
    let mut value = serde_json::json!({ "camera": packet.camera, "draws": packet.draws });
    normalize_semantic_numbers(&mut value);
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&value).expect("normalized semantics must serialize"))
    )
}

#[test]
fn sealed_v10_retains_three_joined_leaves_through_native_evaluation_and_wgpu_prepare() {
    let (fixture, bundle) = fixture();
    assert_eq!(fixture.id, FIXTURE_ID);
    assert_eq!(
        fixture.producer_reference.fast_manim_commit,
        FAST_MANIM_COMMIT
    );
    assert_eq!(
        fixture.producer_reference.kind,
        "server-sealed-real-fast-manim-profile-v10"
    );
    assert_eq!(fixture.producer_reference.snapshot_hash, SNAPSHOT_HASH);
    assert_eq!(
        fixture.producer_reference.source_path,
        "example_scenes/basic.py"
    );
    assert_eq!(fixture.producer_reference.source_sha256, SOURCE_SHA256);
    assert_eq!(fixture.producer_reference.engine_commit.len(), 40);

    let SceneSourceV1::ImportedManimServerSnapshot {
        snapshot_hash,
        snapshot_version,
        source_hash,
        ..
    } = &bundle.scene.source
    else {
        panic!("LineJoints V10 must remain an imported server snapshot");
    };
    assert_eq!(*snapshot_version, SnapshotProfileVersionV1::V10);
    assert_eq!(snapshot_hash, SNAPSHOT_HASH);
    assert_eq!(source_hash, SOURCE_SHA256);
    assert_eq!(bundle.scene.entities.len(), 4);
    assert!(bundle.scene.animation_channels.is_empty());

    let [sample] = fixture.samples.as_slice() else {
        panic!("the static V10 fixture must contain exactly one sample");
    };
    assert_eq!(sample.id, "static");
    let session = EngineSessionV1::new(bundle.clone()).expect("the sealed V10 bundle must install");
    let retained = session
        .sample_render_packet(SampleEngineSessionOptionsV1 {
            evidence: &[fixture.id.clone(), sample.id.clone()],
            packet_id: &sample.packet_id,
            sample_time: sample.sample_time,
            viewport: sample.viewport.clone(),
        })
        .expect("the retained V10 session must sample");
    let reference = compile_render_packet_v1(CompileEngineFrameOptionsV1 {
        assets: &bundle.assets,
        evidence: &[fixture.id.clone(), sample.id.clone()],
        packet_id: &sample.packet_id,
        sample_time: sample.sample_time,
        scene: &bundle.scene,
        viewport: sample.viewport.clone(),
    })
    .expect("the reference V10 evaluator must sample");
    assert_eq!(retained, reference);
    assert_eq!(semantic_digest(&retained), sample.expected.semantic_digest);

    let joins = retained
        .draws
        .iter()
        .map(|draw| match draw {
            RenderDrawV1::Path {
                fill: None,
                stroke: Some(stroke),
                ..
            } => stroke.join.clone(),
            _ => panic!(
                "the VGroup must emit no draw and each Triangle must emit one stroke-only path"
            ),
        })
        .collect::<Vec<_>>();
    assert_eq!(
        joins,
        [
            StrokeJoinV1::Miter,
            StrokeJoinV1::Round,
            StrokeJoinV1::Bevel
        ]
    );

    let direct = prepare_frame_v1(&retained).expect("the V10 packet must prepare for WebGPU");
    let mut cache = PreparedGeometryCacheV1::default();
    let cached = prepare_frame_with_cache_v1(&retained, &mut cache)
        .expect("the V10 packet must prepare through the retained cache");
    assert_eq!(
        direct.geometry_plan().vertices(),
        cached.geometry_plan().vertices()
    );
    assert_eq!(direct.indices(), cached.indices());
    assert_eq!(direct.draws().len(), 3);

    let group_id = &bundle.scene.entities[0].id;
    assert_eq!(direct.clip_bounds_for_entity(group_id), None);
    let bounds = bundle.scene.entities[1..]
        .iter()
        .map(|entity| {
            direct
                .clip_bounds_for_entity(&entity.id)
                .expect("each rendered Triangle must expose interaction bounds")
        })
        .collect::<Vec<_>>();
    assert!(bounds.iter().all(|[min_x, min_y, max_x, max_y]| {
        min_x.is_finite() && min_y.is_finite() && max_x > min_x && max_y > min_y
    }));
    assert!(bounds[0][2] < bounds[1][0] && bounds[1][2] < bounds[2][0]);
}
