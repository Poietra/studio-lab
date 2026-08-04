use std::fs;
use std::path::PathBuf;

use poietra_eval::{
    CompileEngineFrameOptionsV1, EngineSessionV1, SampleEngineSessionOptionsV1,
    compile_render_packet_v1,
};
use poietra_render_wgpu::{PreparedGeometryCacheV1, prepare_frame_v1, prepare_frame_with_cache_v1};
use poietra_scene_ir::{
    RenderDrawV1, RenderPacketV1, SceneCapabilityV1, SceneIrBundleV1, SceneSourceV1,
    SnapshotProfileVersionV1, ViewportV1,
};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const ENGINE_COMMIT: &str = "b14f9cf75eb8c0cd0f255110f43f86142ac3bca2";
const FAST_MANIM_COMMIT: &str = "4a6eaf1b4085ed643698da5116dd23814411eb5b";
const FIXTURE_ID: &str = "eng-v1-real-spiral-in-v11";
const SNAPSHOT_HASH: &str = "fccc297be458cb3a066842d0f94f8d60575dd5492371c82d6d8be1e53b01d1e0";
const SOURCE_SHA256: &str = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const SEMANTIC_NUMBER_SCALE: f64 = 1_000_000_000.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureV11 {
    assets: Value,
    id: String,
    producer_reference: ProducerReferenceV11,
    samples: Vec<SampleV11>,
    scene: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProducerReferenceV11 {
    engine_commit: String,
    fast_manim_commit: String,
    kind: String,
    snapshot_hash: String,
    source_path: String,
    source_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SampleV11 {
    expected: ExpectedV11,
    id: String,
    packet_id: String,
    sample_time: f64,
    viewport: ViewportV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedV11 {
    semantic_digest: String,
}

fn fixture() -> (FixtureV11, SceneIrBundleV1) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/engine-v1/real-spiral-in-v11.json");
    let fixture: FixtureV11 = serde_json::from_slice(
        &fs::read(path).expect("the sealed SpiralIn V11 fixture must be readable"),
    )
    .expect("the sealed SpiralIn V11 fixture must match its envelope");
    let bundle = serde_json::from_value(serde_json::json!({
        "assets": fixture.assets,
        "scene": fixture.scene,
    }))
    .expect("the sealed SpiralIn V11 bundle must match Scene IR");
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

fn semantic_digest(packet: &RenderPacketV1) -> String {
    let mut value = serde_json::json!({ "camera": packet.camera, "draws": packet.draws });
    normalize_semantic_numbers(&mut value);
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&value).expect("normalized semantics must serialize"))
    )
}

#[test]
#[allow(
    clippy::float_cmp,
    clippy::too_many_lines,
    reason = "one vertical-slice proof keeps all seven producer samples and WebGPU invariants together"
)]
fn sealed_v11_retains_five_spiral_leaves_through_native_evaluation_and_wgpu_prepare() {
    let (fixture, bundle) = fixture();
    assert_eq!(fixture.id, FIXTURE_ID);
    assert_eq!(fixture.producer_reference.engine_commit, ENGINE_COMMIT);
    assert_eq!(
        fixture.producer_reference.fast_manim_commit,
        FAST_MANIM_COMMIT
    );
    assert_eq!(
        fixture.producer_reference.kind,
        "server-sealed-real-fast-manim-profile-v11"
    );
    assert_eq!(fixture.producer_reference.snapshot_hash, SNAPSHOT_HASH);
    assert_eq!(
        fixture.producer_reference.source_path,
        "example_scenes/basic.py"
    );
    assert_eq!(fixture.producer_reference.source_sha256, SOURCE_SHA256);

    let SceneSourceV1::ImportedManimServerSnapshot {
        snapshot_hash,
        snapshot_version,
        source_hash,
        ..
    } = &bundle.scene.source
    else {
        panic!("SpiralIn V11 must remain an imported server snapshot");
    };
    assert_eq!(*snapshot_version, SnapshotProfileVersionV1::V11);
    assert_eq!(snapshot_hash, SNAPSHOT_HASH);
    assert_eq!(source_hash, SOURCE_SHA256);
    assert_eq!(bundle.scene.duration, 3.0);
    assert_eq!(bundle.scene.entities.len(), 6);
    assert_eq!(bundle.scene.animation_channels.len(), 11);
    assert_eq!(
        bundle.scene.required_capabilities,
        [
            SceneCapabilityV1::AffineTransformAnimation,
            SceneCapabilityV1::CubicPathGeometry,
            SceneCapabilityV1::LogicalGroup,
            SceneCapabilityV1::OpacityAnimation,
        ]
    );

    let expected_sample_times = [0.0, 0.1, 0.5, 1.0, 1.5, 2.5, 3.0];
    assert_eq!(fixture.samples.len(), expected_sample_times.len());
    let session = EngineSessionV1::new(bundle.clone()).expect("the sealed V11 bundle must install");
    let installed_index = session.retained_index_stats();
    let mut cache = PreparedGeometryCacheV1::default();

    for (sample, expected_time) in fixture.samples.iter().zip(expected_sample_times) {
        assert_eq!(sample.sample_time, expected_time);
        assert_eq!(
            sample.packet_id,
            format!("real-spiral-in-v11:{}", sample.id)
        );
        assert_eq!(
            sample.viewport,
            ViewportV1 {
                height_px: 360,
                width_px: 640,
            }
        );
        let evidence = [fixture.id.clone(), sample.id.clone()];
        let retained = session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &evidence,
                packet_id: &sample.packet_id,
                sample_time: sample.sample_time,
                viewport: sample.viewport.clone(),
            })
            .unwrap_or_else(|error| panic!("retained V11 sample {expected_time} failed: {error}"));
        let reference = compile_render_packet_v1(CompileEngineFrameOptionsV1 {
            assets: &bundle.assets,
            evidence: &evidence,
            packet_id: &sample.packet_id,
            sample_time: sample.sample_time,
            scene: &bundle.scene,
            viewport: sample.viewport.clone(),
        })
        .unwrap_or_else(|error| panic!("reference V11 sample {expected_time} failed: {error}"));
        assert_eq!(retained, reference);
        assert_eq!(semantic_digest(&retained), sample.expected.semantic_digest);

        if expected_time < bundle.scene.duration {
            assert_eq!(retained.draws.len(), 5);
            for ((draw, entity), expected_segment_count) in retained
                .draws
                .iter()
                .zip(&bundle.scene.entities[1..])
                .zip([3, 4, 8, 5, 40])
            {
                let RenderDrawV1::Path {
                    entity_id,
                    fill: Some(_),
                    path,
                    stroke: None,
                    ..
                } = draw
                else {
                    panic!("each active SpiralIn leaf must emit one fill-only cubic path");
                };
                assert_eq!(entity_id, &entity.id);
                assert_eq!(path.subpaths.len(), 1);
                assert!(path.subpaths[0].closed);
                assert_eq!(path.subpaths[0].segments.len(), expected_segment_count);
            }
        } else {
            assert!(retained.draws.is_empty(), "duration-end must be inactive");
        }

        let direct = prepare_frame_v1(&retained).unwrap_or_else(|error| {
            panic!("direct V11 prepare failed at {expected_time}: {error}")
        });
        let cached = prepare_frame_with_cache_v1(&retained, &mut cache).unwrap_or_else(|error| {
            panic!("cached V11 prepare failed at {expected_time}: {error}")
        });
        assert_eq!(direct.indices(), cached.indices());
        assert_eq!(
            direct.geometry_plan().vertices(),
            cached.geometry_plan().vertices()
        );
        assert_eq!(direct.material_plan(), cached.material_plan());
        assert_eq!(direct.ordered_draw_plan(), cached.ordered_draw_plan());
        assert_eq!(direct.viewport(), cached.viewport());
        assert_eq!(
            direct.clip_bounds_for_entity(&bundle.scene.entities[0].id),
            None
        );

        if expected_time < bundle.scene.duration {
            assert_eq!(direct.draws().len(), 5);
            for entity in &bundle.scene.entities[1..] {
                let [min_x, min_y, max_x, max_y] = direct
                    .clip_bounds_for_entity(&entity.id)
                    .expect("each active SpiralIn leaf must expose interaction bounds");
                assert!(min_x.is_finite() && min_y.is_finite());
                assert!(max_x > min_x && max_y > min_y);
            }
        } else {
            assert!(direct.draws().is_empty());
            assert!(direct.indices().is_empty());
            for entity in &bundle.scene.entities[1..] {
                assert_eq!(direct.clip_bounds_for_entity(&entity.id), None);
            }
        }
        assert_eq!(session.retained_index_stats(), installed_index);
    }
}
