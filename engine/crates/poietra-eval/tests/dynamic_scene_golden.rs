use std::fs;
use std::path::PathBuf;

use poietra_eval::{EngineSessionV1, SampleEngineSessionOptionsV1};
use poietra_scene_ir::{
    AffineTransformV1, RenderDrawV1, RenderPacketV1, SceneIrBundleV1, ViewportV1,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const SEMANTIC_NUMBER_SCALE: f64 = 1_000_000_000.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DynamicFixture {
    assets: serde_json::Value,
    id: String,
    samples: Vec<DynamicSample>,
    scene: serde_json::Value,
    timeline_proof: TimelineProof,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimelineProof {
    sample_count: usize,
    sample_rate_hz: usize,
    semantic_digest: String,
    shuffle_stride: usize,
    viewport: ViewportV1,
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

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ExpectedSample {
    camera: [f64; 4],
    draw_digest: String,
    draw_entity_ids: Vec<String>,
    opacities: Vec<f64>,
    semantic_digest: String,
    world_transforms: Vec<ExpectedTransform>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ExpectedTransform {
    entity_id: String,
    values: [f64; 6],
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

fn transform_values(transform: &AffineTransformV1) -> [f64; 6] {
    [
        transform.m11,
        transform.m12,
        transform.m21,
        transform.m22,
        transform.tx,
        transform.ty,
    ]
}

#[allow(clippy::cast_possible_truncation)]
fn normalize_semantic_numbers(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Number(number) => {
            // Rust and JavaScript cubic evaluation may differ by a few ULPs.
            // Keep those values equal while still pinning meaningful changes.
            let scaled = (number.as_f64().expect("fixture semantics must be numeric")
                * SEMANTIC_NUMBER_SCALE)
                .round() as i64;
            *number = scaled.into();
        }
        serde_json::Value::Array(entries) => {
            entries.iter_mut().for_each(normalize_semantic_numbers);
        }
        serde_json::Value::Object(entries) => {
            entries.values_mut().for_each(normalize_semantic_numbers);
        }
        serde_json::Value::Bool(_) | serde_json::Value::Null | serde_json::Value::String(_) => {}
    }
}

fn digest_semantic_value(value: &impl Serialize) -> String {
    let mut normalized = serde_json::to_value(value).expect("frame semantics must serialize");
    normalize_semantic_numbers(&mut normalized);
    let canonical = serde_json::to_vec(&normalized).expect("normalized semantics must serialize");
    format!("{:x}", Sha256::digest(canonical))
}

fn summarize(packet: &RenderPacketV1) -> ExpectedSample {
    let camera = [
        packet.camera.bottom,
        packet.camera.left,
        packet.camera.right,
        packet.camera.top,
    ];
    ExpectedSample {
        camera,
        draw_digest: digest_semantic_value(&packet.draws),
        draw_entity_ids: packet
            .draws
            .iter()
            .map(|draw| draw.entity_id().to_owned())
            .collect(),
        opacities: packet.draws.iter().map(RenderDrawV1::opacity).collect(),
        semantic_digest: digest_semantic_value(&serde_json::json!({
            "camera": packet.camera,
            "draws": packet.draws,
        })),
        world_transforms: packet
            .draws
            .iter()
            .map(|draw| match draw {
                RenderDrawV1::Empty {
                    entity_id, reason, ..
                } => panic!(
                    "dynamic fixture entity {entity_id} unexpectedly lowered to an empty draw: {reason:?}"
                ),
                RenderDrawV1::Path {
                    entity_id,
                    transform,
                    ..
                }
                | RenderDrawV1::Image {
                    entity_id,
                    transform,
                    ..
                } => ExpectedTransform {
                    entity_id: entity_id.clone(),
                    values: transform_values(transform),
                },
            })
            .collect(),
    }
}

fn assert_numbers_close(actual: &[f64], expected: &[f64]) {
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(expected) {
        assert!(
            (actual - expected).abs() <= 1e-12,
            "{actual:?} was not within 1e-12 of {expected:?}"
        );
    }
}

fn timeline_index_as_f64(value: usize) -> f64 {
    f64::from(u32::try_from(value).expect("timeline proof values must fit in u32"))
}

fn timeline_semantic_digest(
    session: &EngineSessionV1,
    fixture_id: &str,
    proof: &TimelineProof,
    order: &[usize],
) -> String {
    let mut digests = vec![None; proof.sample_count];
    for &sample_index in order {
        let evidence_id = format!("timeline:{sample_index}");
        let evidence = [fixture_id.to_owned(), evidence_id];
        let packet_id = format!("dynamic:timeline:{sample_index}");
        let packet = session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &evidence,
                packet_id: &packet_id,
                sample_time: timeline_index_as_f64(sample_index)
                    / timeline_index_as_f64(proof.sample_rate_hz),
                viewport: proof.viewport.clone(),
            })
            .unwrap_or_else(|error| panic!("timeline:{sample_index} must evaluate: {error}"));
        assert!(
            digests[sample_index]
                .replace(summarize(&packet).semantic_digest)
                .is_none(),
            "timeline sample {sample_index} was repeated"
        );
    }
    let mut hasher = Sha256::new();
    for digest in digests {
        hasher.update(
            digest
                .expect("every timeline sample must be evaluated")
                .as_bytes(),
        );
    }
    format!("{:x}", hasher.finalize())
}

#[test]
fn retained_evaluator_matches_shared_dynamic_golden_across_unordered_seeks() {
    let (fixture, bundle) = load_fixture();
    assert_numbers_close(&[bundle.scene.duration], &[60.0]);
    assert_numbers_close(
        &fixture
            .samples
            .iter()
            .map(|sample| sample.sample_time)
            .collect::<Vec<_>>(),
        &[0.75, 0.0, 0.5, 0.25, 0.75, 60.0, 0.75],
    );
    let session = EngineSessionV1::new(bundle).expect("dynamic fixture must install");
    let mut summaries = std::collections::BTreeMap::new();

    for sample in fixture.samples {
        let packet = session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &[fixture.id.clone(), sample.id.clone()],
                packet_id: &sample.packet_id,
                sample_time: sample.sample_time,
                viewport: sample.viewport,
            })
            .unwrap_or_else(|error| panic!("{} must evaluate: {error}", sample.id));
        let actual = summarize(&packet);
        assert_eq!(
            actual.draw_digest, sample.expected.draw_digest,
            "{}",
            sample.id
        );
        assert_eq!(
            actual.semantic_digest, sample.expected.semantic_digest,
            "{}",
            sample.id
        );
        assert_eq!(
            actual.draw_entity_ids, sample.expected.draw_entity_ids,
            "{}",
            sample.id
        );
        assert_numbers_close(&actual.camera, &sample.expected.camera);
        assert_numbers_close(&actual.opacities, &sample.expected.opacities);
        assert_eq!(
            actual
                .world_transforms
                .iter()
                .map(|transform| transform.entity_id.as_str())
                .collect::<Vec<_>>(),
            sample
                .expected
                .world_transforms
                .iter()
                .map(|transform| transform.entity_id.as_str())
                .collect::<Vec<_>>(),
            "{}",
            sample.id
        );
        for (actual, expected) in actual
            .world_transforms
            .iter()
            .zip(&sample.expected.world_transforms)
        {
            assert_numbers_close(&actual.values, &expected.values);
        }
        summaries.insert(sample.id, actual);
    }

    assert_eq!(
        summaries["b-start"].draw_entity_ids,
        ["dynamic-parent", "asymmetric-child"]
    );
    assert!(summaries["duration-end"].draw_entity_ids.is_empty());
    assert_eq!(summaries["a-repeat"], summaries["a-first"]);
    assert_eq!(summaries["a-after-end"], summaries["a-first"]);
}

#[test]
fn retained_evaluator_keeps_the_sixty_second_timeline_history_free() {
    let (fixture, bundle) = load_fixture();
    let proof = &fixture.timeline_proof;
    let timeline_end =
        timeline_index_as_f64(proof.sample_count - 1) / timeline_index_as_f64(proof.sample_rate_hz);
    assert!((bundle.scene.duration - timeline_end).abs() <= f64::EPSILON);
    let ordered = (0..proof.sample_count).collect::<Vec<_>>();
    let shuffled = ordered
        .iter()
        .map(|index| index * proof.shuffle_stride % proof.sample_count)
        .collect::<Vec<_>>();
    let continuous_scrub = ordered.iter().rev().copied().collect::<Vec<_>>();
    let unique = shuffled
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(unique.len(), proof.sample_count);
    assert!(
        continuous_scrub
            .windows(2)
            .all(|samples| samples[0] == samples[1] + 1)
    );

    let session = EngineSessionV1::new(bundle).expect("dynamic fixture must install");
    for order in [&ordered, &shuffled, &continuous_scrub] {
        assert_eq!(
            timeline_semantic_digest(&session, &fixture.id, proof, order),
            proof.semantic_digest
        );
    }
}
