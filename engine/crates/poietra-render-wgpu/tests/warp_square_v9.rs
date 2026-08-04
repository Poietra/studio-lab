use std::collections::BTreeMap;
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

const ENGINE_COMMIT: &str = "0b331ce781411f38185dcabccdffdccee02d4376";
const FAST_MANIM_COMMIT: &str = "2c1e56287193e3acddbe6779f6ecd4bd91094588";
const FIXTURE_ID: &str = "eng-v1-real-warp-square-v9";
const SNAPSHOT_HASH: &str = "b8854f07baa588b01a2a5694d8ade2800601f1e26b6e12d626cc170ffa1be9ed";
const SOURCE_PATH: &str = "example_scenes/basic.py";
const SOURCE_SHA256: &str = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const SEMANTIC_NUMBER_SCALE: f64 = 1_000_000_000.0;
const NON_MONOTONIC_SAMPLE_TIMES: [f64; 9] = [3.5, 0.25, 3.0, 0.0, 2.75, 1.5, 4.0, 3.0, 0.25];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WarpSquareFixtureV9 {
    assets: Value,
    id: String,
    producer_reference: ProducerReferenceV9,
    samples: Vec<FixtureSampleV9>,
    scene: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProducerReferenceV9 {
    engine_commit: String,
    fast_manim_commit: String,
    kind: String,
    snapshot_hash: String,
    source_path: String,
    source_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureSampleV9 {
    expected: ExpectedSampleV9,
    id: String,
    packet_id: String,
    sample_time: f64,
    viewport: ViewportV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedSampleV9 {
    semantic_digest: String,
}

fn fixture() -> (WarpSquareFixtureV9, SceneIrBundleV1) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/engine-v1/real-warp-square-v9.json");
    let fixture: WarpSquareFixtureV9 = serde_json::from_slice(
        &fs::read(path).expect("the real fast-manim WarpSquare V9 fixture must be readable"),
    )
    .expect("the real fast-manim WarpSquare V9 fixture must match its envelope");
    let bundle = serde_json::from_value(serde_json::json!({
        "assets": fixture.assets,
        "scene": fixture.scene,
    }))
    .expect("the real fast-manim WarpSquare V9 bundle must match Scene IR");
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

fn render_packet_semantic_digest(packet: &RenderPacketV1) -> String {
    let mut normalized = serde_json::json!({
        "camera": packet.camera,
        "draws": packet.draws,
    });
    normalize_semantic_numbers(&mut normalized);
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&normalized).expect("normalized frame semantics must serialize")
        )
    )
}

fn assert_direct_and_cached_prepare_match(
    sample_time: f64,
    packet: &RenderPacketV1,
    cache: &mut PreparedGeometryCacheV1,
) {
    let direct = prepare_frame_v1(packet)
        .unwrap_or_else(|error| panic!("direct WGPU prepare failed at {sample_time}: {error}"));
    let cached = prepare_frame_with_cache_v1(packet, cache)
        .unwrap_or_else(|error| panic!("cached WGPU prepare failed at {sample_time}: {error}"));

    assert_eq!(direct.indices(), cached.indices());
    assert_eq!(
        direct.geometry_plan().vertices(),
        cached.geometry_plan().vertices()
    );
    assert_eq!(direct.material_plan(), cached.material_plan());
    assert_eq!(direct.ordered_draw_plan(), cached.ordered_draw_plan());
    assert_eq!(direct.viewport(), cached.viewport());

    if sample_time < 4.0 {
        assert_eq!(direct.draws().len(), 1);
        assert!(!direct.indices().is_empty());
    } else {
        assert!(direct.draws().is_empty());
        assert!(direct.indices().is_empty());
    }
}

#[test]
#[allow(
    clippy::float_cmp,
    clippy::too_many_lines,
    reason = "one audited temporal proof keeps the producer pins and all forward/non-monotonic samples together"
)]
fn real_v9_retained_sampling_and_wgpu_prepare_match_reference_across_unordered_seeks() {
    let (fixture, bundle) = fixture();
    assert_eq!(fixture.id, FIXTURE_ID);
    assert_eq!(fixture.producer_reference.engine_commit, ENGINE_COMMIT);
    assert_eq!(
        fixture.producer_reference.fast_manim_commit,
        FAST_MANIM_COMMIT
    );
    assert_eq!(
        fixture.producer_reference.kind,
        "server-sealed-real-fast-manim-profile-v9"
    );
    assert_eq!(fixture.producer_reference.snapshot_hash, SNAPSHOT_HASH);
    assert_eq!(fixture.producer_reference.source_path, SOURCE_PATH);
    assert_eq!(fixture.producer_reference.source_sha256, SOURCE_SHA256);

    let SceneSourceV1::ImportedManimServerSnapshot {
        snapshot_hash,
        snapshot_version,
        source_hash,
        ..
    } = &bundle.scene.source
    else {
        panic!("real WarpSquare V9 must remain an imported fast-manim snapshot");
    };
    assert_eq!(*snapshot_version, SnapshotProfileVersionV1::V9);
    assert_eq!(snapshot_hash, SNAPSHOT_HASH);
    assert_eq!(source_hash, SOURCE_SHA256);
    assert_eq!(bundle.scene.source.revision_hash(), SNAPSHOT_HASH);
    assert_eq!(bundle.scene.duration.to_bits(), 4.0_f64.to_bits());
    assert_eq!(bundle.scene.entities.len(), 1);
    assert_eq!(bundle.scene.animation_channels.len(), 1);
    assert_eq!(
        bundle.scene.required_capabilities,
        [
            SceneCapabilityV1::CubicPathGeometry,
            SceneCapabilityV1::PathMorphAnimation,
        ]
    );

    let expected_sample_times: [f64; 8] = [0.0, 0.25, 0.75, 1.5, 2.75, 3.0, 3.5, 4.0];
    assert_eq!(fixture.samples.len(), expected_sample_times.len());
    for (sample, expected_time) in fixture.samples.iter().zip(expected_sample_times) {
        assert_eq!(sample.sample_time.to_bits(), expected_time.to_bits());
        assert_eq!(
            sample.viewport,
            ViewportV1 {
                height_px: 360,
                width_px: 640
            }
        );
        assert_eq!(
            sample.packet_id,
            format!("real-warp-square-v9:{}", sample.id)
        );
    }

    let session = EngineSessionV1::new(bundle.clone())
        .expect("the real WarpSquare V9 fixture must install once");
    let installed_index = session.retained_index_stats();
    let mut cache = PreparedGeometryCacheV1::default();
    let mut draws_by_time = BTreeMap::<u64, Vec<RenderDrawV1>>::new();

    for (seek_index, sample_time) in fixture
        .samples
        .iter()
        .map(|sample| sample.sample_time)
        .chain(NON_MONOTONIC_SAMPLE_TIMES)
        .enumerate()
    {
        let packet_id = format!("warp-square-v9:{seek_index}:{sample_time}");
        let evidence = [fixture.id.clone(), format!("sample:{sample_time}")];
        let retained = session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &evidence,
                packet_id: &packet_id,
                sample_time,
                viewport: ViewportV1 {
                    height_px: 360,
                    width_px: 640,
                },
            })
            .unwrap_or_else(|error| panic!("retained V9 sample {sample_time} failed: {error}"));
        let reference = compile_render_packet_v1(CompileEngineFrameOptionsV1 {
            assets: &bundle.assets,
            evidence: &evidence,
            packet_id: &packet_id,
            sample_time,
            scene: &bundle.scene,
            viewport: ViewportV1 {
                height_px: 360,
                width_px: 640,
            },
        })
        .unwrap_or_else(|error| panic!("reference V9 sample {sample_time} failed: {error}"));
        assert_eq!(
            retained, reference,
            "retained sample diverged at {sample_time}"
        );

        if let Some(previous) = draws_by_time.insert(sample_time.to_bits(), retained.draws.clone())
        {
            assert_eq!(
                retained.draws, previous,
                "unordered seek changed {sample_time}"
            );
        }

        if sample_time < 4.0 {
            let [
                RenderDrawV1::Path {
                    entity_id,
                    fill: None,
                    path,
                    stroke: Some(_),
                    ..
                },
            ] = retained.draws.as_slice()
            else {
                panic!("V9 sample {sample_time} must retain exactly one stroke-only path");
            };
            assert_eq!(entity_id, &bundle.scene.entities[0].id);
            assert_eq!(path.subpaths.len(), 1);
            assert!(path.subpaths[0].closed);
            assert_eq!(path.subpaths[0].segments.len(), 4);
        } else {
            assert!(retained.draws.is_empty(), "duration-end must be inactive");
        }

        assert_direct_and_cached_prepare_match(sample_time, &retained, &mut cache);
        assert_eq!(session.retained_index_stats(), installed_index);
    }

    for sample in &fixture.samples {
        let packet = session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &[fixture.id.clone(), sample.id.clone()],
                packet_id: &sample.packet_id,
                sample_time: sample.sample_time,
                viewport: sample.viewport.clone(),
            })
            .unwrap();
        assert_eq!(packet.scene_revision_hash, SNAPSHOT_HASH);
        let digest = render_packet_semantic_digest(&packet);
        assert_eq!(
            digest, sample.expected.semantic_digest,
            "{} digest drifted",
            sample.id
        );
    }
    assert_eq!(
        draws_by_time[&3.0_f64.to_bits()],
        draws_by_time[&3.5_f64.to_bits()],
        "the final WarpSquare target must remain visible during the one-second wait"
    );

    assert_eq!(session.retained_index_stats(), installed_index);
}
