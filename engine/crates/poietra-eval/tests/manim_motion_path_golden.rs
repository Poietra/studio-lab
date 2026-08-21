use std::fs;
use std::path::PathBuf;

use poietra_eval::{EngineSessionV1, SampleEngineSessionOptionsV1};
use poietra_scene_ir::{
    AnimationChannelV1, RenderDrawV1, SceneIrBundleV1, ViewportV1, validate_scene_ir_v1,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    assets: serde_json::Value,
    reference: Reference,
    samples: Vec<Sample>,
    scene: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reference {
    commit: String,
    sample_points_per_curve: usize,
    symbol: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    sample_time: f64,
    translation: [f64; 2],
}

#[test]
fn retained_evaluator_matches_manim_curved_interior_samples_across_unordered_seeks() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/engine-v1/manim-motion-path.json");
    let fixture: Fixture = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(fixture.reference.sample_points_per_curve, 10);
    assert_eq!(
        fixture.reference.symbol,
        "manim.mobject.types.vectorized_mobject.VMobject.point_from_proportion"
    );
    assert_eq!(
        fixture
            .samples
            .iter()
            .map(|sample| sample.sample_time)
            .collect::<Vec<_>>(),
        [0.75, 0.0, 0.5, 0.25, 0.75, 1.0, 0.125, 0.875]
    );

    let bundle: SceneIrBundleV1 = serde_json::from_value(serde_json::json!({
        "assets": fixture.assets,
        "scene": fixture.scene,
    }))
    .unwrap();
    let mut oriented_bundle = bundle.clone();
    let Some(AnimationChannelV1::MotionPath { orient_to_path, .. }) =
        oriented_bundle.scene.animation_channels.first_mut()
    else {
        panic!("fixture must contain its motion-path channel");
    };
    *orient_to_path = true;
    validate_scene_ir_v1(&oriented_bundle.scene).unwrap();
    let session = EngineSessionV1::new(bundle).unwrap();
    let oriented_session = EngineSessionV1::new(oriented_bundle).unwrap();
    let mut observed = Vec::new();
    let mut observed_orientation = false;
    for (index, sample) in fixture.samples.iter().enumerate() {
        let packet_id = format!("manim-motion:{index}");
        let packet = session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: std::slice::from_ref(&fixture.reference.commit),
                packet_id: &packet_id,
                sample_time: sample.sample_time,
                viewport: ViewportV1 {
                    height_px: 90,
                    width_px: 160,
                },
            })
            .unwrap();
        let Some(RenderDrawV1::Path { transform, .. }) = packet.draws.first() else {
            panic!("expected the retained motion-path draw");
        };
        assert!((transform.tx - sample.translation[0]).abs() <= 1.0e-12);
        assert!((transform.ty - sample.translation[1]).abs() <= 1.0e-12);
        let oriented_packet_id = format!("manim-motion-oriented:{index}");
        let oriented_packet = oriented_session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: std::slice::from_ref(&fixture.reference.commit),
                packet_id: &oriented_packet_id,
                sample_time: sample.sample_time,
                viewport: ViewportV1 {
                    height_px: 90,
                    width_px: 160,
                },
            })
            .unwrap();
        let Some(RenderDrawV1::Path {
            transform: oriented_transform,
            ..
        }) = oriented_packet.draws.first()
        else {
            panic!("expected the oriented motion-path draw");
        };
        assert_eq!(oriented_transform.tx.to_bits(), transform.tx.to_bits());
        assert_eq!(oriented_transform.ty.to_bits(), transform.ty.to_bits());
        observed_orientation |= oriented_transform.m12 != 0.0 || oriented_transform.m21 != 0.0;
        observed.push([transform.tx, transform.ty]);
    }
    assert_eq!(observed[0].map(f64::to_bits), observed[4].map(f64::to_bits));
    assert!(observed_orientation);
}
