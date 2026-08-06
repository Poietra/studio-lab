use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use poietra_eval::{EngineSessionV1, SampleEngineSessionOptionsV1};
use poietra_render_wgpu::prepare_frame_v1;
use poietra_scene_ir::{SceneIrBundleV1, ViewportV1};
use serde::Deserialize;

const ENTITY_IDS: [&str; 3] = ["asymmetric-child", "dynamic-parent", "trim-motion-child"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DynamicFixture {
    assets: serde_json::Value,
    id: String,
    samples: Vec<DynamicSample>,
    scene: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DynamicSample {
    expected: ExpectedSample,
    id: String,
    packet_id: String,
    sample_time: f64,
    viewport: ViewportV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedSample {
    prepared_clip_bounds: BTreeMap<String, Option<[f32; 4]>>,
}

fn load_fixture() -> (DynamicFixture, SceneIrBundleV1) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/engine-v1/dynamic-affine-camera.json");
    let fixture: DynamicFixture =
        serde_json::from_slice(&fs::read(path).expect("shared dynamic fixture must be readable"))
            .expect("shared dynamic fixture must match its envelope");
    let bundle = serde_json::from_value(serde_json::json!({
        "assets": fixture.assets,
        "scene": fixture.scene,
    }))
    .expect("shared dynamic fixture must contain a valid Scene IR bundle");
    (fixture, bundle)
}

fn assert_bounds_close(actual: Option<[f32; 4]>, expected: Option<[f32; 4]>) {
    match (actual, expected) {
        (Some(actual), Some(expected)) => {
            for (actual, expected) in actual.into_iter().zip(expected) {
                assert!(
                    (actual - expected).abs() <= 1e-6,
                    "{actual:?} was not within 1e-6 of {expected:?}"
                );
            }
        }
        (None, None) => {}
        (actual, expected) => panic!("bounds presence differs: {actual:?} != {expected:?}"),
    }
}

#[test]
fn prepared_clip_bounds_follow_dynamic_camera_hierarchy_and_lifetime() {
    let (fixture, bundle) = load_fixture();
    let session = EngineSessionV1::new(bundle).expect("dynamic fixture must install");
    let mut samples = BTreeMap::new();

    for sample in fixture.samples {
        let packet = session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &[fixture.id.clone(), sample.id.clone()],
                packet_id: &sample.packet_id,
                sample_time: sample.sample_time,
                viewport: sample.viewport,
            })
            .unwrap_or_else(|error| panic!("{} must evaluate: {error}", sample.id));
        let prepared = prepare_frame_v1(&packet)
            .unwrap_or_else(|error| panic!("{} must prepare: {error}", sample.id));
        let actual = ENTITY_IDS
            .into_iter()
            .map(|entity_id| {
                (
                    entity_id.to_owned(),
                    prepared.clip_bounds_for_entity(entity_id),
                )
            })
            .collect::<BTreeMap<_, _>>();

        let expected = sample.expected.prepared_clip_bounds;
        assert_eq!(
            actual.keys().collect::<Vec<_>>(),
            expected.keys().collect::<Vec<_>>()
        );
        for entity_id in ENTITY_IDS {
            assert_bounds_close(actual[entity_id], expected[entity_id]);
        }
        samples.insert(sample.id, actual);
    }

    assert!(samples["b-start"]["trim-motion-child"].is_none());
    assert!(samples["duration-end"].values().all(Option::is_none));
    assert_eq!(samples["a-repeat"], samples["a-first"]);
    assert_eq!(samples["a-after-end"], samples["a-first"]);
}

#[test]
fn interaction_bounds_keep_drawable_parent_separate_from_descendants() {
    let (fixture, bundle) = load_fixture();
    let session = EngineSessionV1::new(bundle.clone()).expect("dynamic fixture must install");
    let sample = fixture
        .samples
        .iter()
        .find(|sample| sample.id == "a-first")
        .expect("dynamic fixture must retain the first repeated sample");
    let packet = session
        .sample_render_packet(SampleEngineSessionOptionsV1 {
            evidence: &[fixture.id, sample.id.clone()],
            packet_id: &sample.packet_id,
            sample_time: sample.sample_time,
            viewport: sample.viewport.clone(),
        })
        .expect("the first dynamic sample must evaluate");
    let prepared = prepare_frame_v1(&packet).expect("the first dynamic sample must prepare");
    let parent_bounds = prepared
        .clip_bounds_for_entity("dynamic-parent")
        .expect("the drawable parent must have direct bounds");
    let child_bounds = prepared
        .clip_bounds_for_entity("asymmetric-child")
        .expect("the drawable child must have direct bounds");
    assert!(
        child_bounds[0] < parent_bounds[0],
        "the fixture child must extend beyond the parent so a descendant union is observable"
    );

    let interaction_bounds = prepared
        .interaction_clip_bounds_by_entity(&bundle.scene)
        .expect("the installed Scene must match its prepared packet");
    assert_eq!(
        interaction_bounds.get("dynamic-parent"),
        Some(&parent_bounds),
        "a drawable parent hit target must not absorb descendant-only geometry"
    );
    assert_eq!(
        interaction_bounds.get("asymmetric-child"),
        Some(&child_bounds)
    );
}
