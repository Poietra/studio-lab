use std::fs;
use std::path::PathBuf;

use poietra_eval::{EngineSessionV1, SampleEngineSessionOptionsV1};
use poietra_scene_ir::{
    AnimationChannelV1, FragmentMaterialV1, RenderDrawV1, SceneCapabilityV1, SceneIrBundleV1,
    StrokeCapV1, StrokeJoinV1, StrokeStyleV1, VectorAppearanceValueV1, ViewportV1,
    validate_scene_ir_v1,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fixture {
    assets: serde_json::Value,
    id: String,
    samples: Vec<FixtureSample>,
    scene: serde_json::Value,
    viewport: ViewportV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixtureSample {
    expected: VectorAppearanceValueV1,
    id: String,
    sample_time: f64,
}

fn fixture() -> (Fixture, SceneIrBundleV1) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/engine-v1/vector-appearance-square-circle.json");
    let fixture: Fixture = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let bundle = serde_json::from_value(serde_json::json!({
        "assets": fixture.assets,
        "scene": fixture.scene,
    }))
    .unwrap();
    (fixture, bundle)
}

fn assert_close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= 1.0e-14 * expected.abs().max(1.0),
        "expected {expected}, received {actual}"
    );
}

fn assert_appearance(
    fill: &poietra_scene_ir::FillStyleV1,
    stroke: &StrokeStyleV1,
    expected: &VectorAppearanceValueV1,
) {
    let expected_fill = expected.fill.as_ref().unwrap();
    let expected_stroke = expected.stroke.as_ref().unwrap();
    assert_eq!(fill.rule, expected_fill.rule);
    assert_close(fill.color.alpha, expected_fill.color.alpha);
    assert_close(fill.color.blue, expected_fill.color.blue);
    assert_close(fill.color.green, expected_fill.color.green);
    assert_close(fill.color.red, expected_fill.color.red);
    assert_eq!(stroke.cap, expected_stroke.cap);
    assert_eq!(stroke.join, expected_stroke.join);
    assert_close(stroke.miter_limit, expected_stroke.miter_limit);
    assert_close(stroke.width_world, expected_stroke.width_world);
    assert_close(stroke.color.alpha, expected_stroke.color.alpha);
    assert_close(stroke.color.blue, expected_stroke.color.blue);
    assert_close(stroke.color.green, expected_stroke.color.green);
    assert_close(stroke.color.red, expected_stroke.color.red);
}

#[test]
fn retained_evaluator_matches_square_to_circle_appearance_at_unordered_boundary_samples() {
    let (fixture, bundle) = fixture();
    assert_eq!(
        fixture
            .samples
            .iter()
            .map(|sample| sample.sample_time)
            .collect::<Vec<_>>(),
        vec![1.5, 1.0, 1.25, 2.0, 1.5]
    );
    assert_close(bundle.scene.entities[0].lifetimes[0].start, 0.0);
    assert_close(bundle.scene.entities[0].lifetimes[0].end, 3.0);
    assert!(matches!(
        &bundle.scene.animation_channels[..],
        [
            AnimationChannelV1::PathMorph { entity_id: morph, .. },
            AnimationChannelV1::VectorAppearance { entity_id: appearance, .. }
        ] if morph == "shape" && appearance == "shape"
    ));
    let session = EngineSessionV1::new(bundle).unwrap();
    let mut first_midpoint = None;
    for sample in &fixture.samples {
        let packet = session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &[fixture.id.clone(), sample.id.clone()],
                packet_id: &format!("appearance:{}", sample.id),
                sample_time: sample.sample_time,
                viewport: fixture.viewport.clone(),
            })
            .unwrap();
        let RenderDrawV1::Path {
            entity_id,
            fill: Some(fill),
            stroke: Some(stroke),
            ..
        } = &packet.draws[0]
        else {
            panic!("{} must sample one materialized path", sample.id);
        };
        assert_eq!(entity_id, "shape");
        assert_appearance(fill, stroke, &sample.expected);
        if sample.id == "midpoint-first" {
            first_midpoint = Some((fill.clone(), stroke.clone()));
        } else if sample.id == "midpoint-repeat" {
            assert_eq!(
                first_midpoint.as_ref(),
                Some(&(fill.clone(), stroke.clone()))
            );
        }
    }

    let before = session
        .sample_render_packet(SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "appearance:before",
            sample_time: 0.5,
            viewport: fixture.viewport.clone(),
        })
        .unwrap();
    assert!(matches!(
        &before.draws[0],
        RenderDrawV1::Path { fill: None, .. }
    ));
}

#[test]
fn contract_rejects_implicit_cross_fades_and_samples_stroke_width() {
    let (_, bundle) = fixture();

    let mut absent = bundle.scene.clone();
    let AnimationChannelV1::VectorAppearance { keyframes, .. } = &mut absent.animation_channels[1]
    else {
        panic!("fixture appearance channel is missing");
    };
    keyframes[1].value.fill = None;
    assert!(
        validate_scene_ir_v1(&absent)
            .unwrap_err()
            .contains_message("absent and solid fill")
    );

    let mut opaque = bundle.scene.clone();
    let AnimationChannelV1::VectorAppearance { keyframes, .. } = &mut opaque.animation_channels[1]
    else {
        unreachable!()
    };
    keyframes[0].value.fill.as_mut().unwrap().color.alpha = 1.0;
    assert!(
        validate_scene_ir_v1(&opaque)
            .unwrap_err()
            .contains_message("transparent solid fill")
    );

    let mut width_bundle = bundle;
    let AnimationChannelV1::VectorAppearance { keyframes, .. } =
        &mut width_bundle.scene.animation_channels[1]
    else {
        unreachable!()
    };
    keyframes[1].value.stroke.as_mut().unwrap().width_world = 0.08;
    let session = EngineSessionV1::new(width_bundle).unwrap();
    let packet = session
        .sample_render_packet(SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "appearance:width",
            sample_time: 1.25,
            viewport: ViewportV1 {
                height_px: 90,
                width_px: 160,
            },
        })
        .unwrap();
    let RenderDrawV1::Path {
        stroke: Some(stroke),
        ..
    } = &packet.draws[0]
    else {
        panic!("expected a stroked path");
    };
    assert_close(stroke.width_world, 0.042_804_148_661_804_33);
}

#[test]
fn contract_allows_only_parameter_changes_within_one_fragment_material_identity() {
    let (_, mut bundle) = fixture();
    let material = FragmentMaterialV1 {
        parameters: vec![0.35, 8.0],
        revision: 1,
        shader_id: "project-wave".to_owned(),
        texture: None,
    };
    let AnimationChannelV1::VectorAppearance { keyframes, .. } =
        &mut bundle.scene.animation_channels[1]
    else {
        unreachable!()
    };
    for keyframe in keyframes.iter_mut() {
        keyframe.value.fill.as_mut().unwrap().fragment_material = Some(material.clone());
    }
    keyframes[1]
        .value
        .fill
        .as_mut()
        .unwrap()
        .fragment_material
        .as_mut()
        .unwrap()
        .parameters[0] = 0.85;
    let first_fill = keyframes[0].value.fill.clone();
    let poietra_scene_ir::SceneAppearanceV1::Vector { fill, .. } =
        &mut bundle.scene.entities[0].appearance
    else {
        unreachable!()
    };
    *fill = first_fill;
    bundle
        .scene
        .required_capabilities
        .push(SceneCapabilityV1::FragmentMaterial);
    bundle.scene.required_capabilities.sort();

    validate_scene_ir_v1(&bundle.scene).unwrap();
    let mut changed_identity = bundle.scene.clone();
    let AnimationChannelV1::VectorAppearance { keyframes, .. } =
        &mut changed_identity.animation_channels[1]
    else {
        unreachable!()
    };
    keyframes[1]
        .value
        .fill
        .as_mut()
        .unwrap()
        .fragment_material
        .as_mut()
        .unwrap()
        .revision = 2;
    assert!(
        validate_scene_ir_v1(&changed_identity)
            .unwrap_err()
            .contains_message("fragment materials")
    );
}

#[test]
fn stroke_cap_and_join_keyframes_are_left_held_at_the_boundary() {
    let (fixture, mut bundle) = fixture();
    let AnimationChannelV1::VectorAppearance { keyframes, .. } =
        &mut bundle.scene.animation_channels[1]
    else {
        panic!("fixture appearance channel is missing");
    };
    let terminal_stroke = keyframes[1].value.stroke.as_mut().unwrap();
    terminal_stroke.cap = StrokeCapV1::Round;
    terminal_stroke.join = StrokeJoinV1::Bevel;

    validate_scene_ir_v1(&bundle.scene).unwrap();
    let session = EngineSessionV1::new(bundle).unwrap();
    let sample_stroke = |sample_time| {
        let packet = session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "appearance:discrete-stroke",
                sample_time,
                viewport: fixture.viewport.clone(),
            })
            .unwrap();
        let RenderDrawV1::Path {
            stroke: Some(stroke),
            ..
        } = &packet.draws[0]
        else {
            panic!("expected a stroked path");
        };
        (stroke.cap, stroke.join)
    };

    assert_eq!(
        sample_stroke(f64::from_bits(2.0_f64.to_bits() - 1)),
        (StrokeCapV1::Butt, StrokeJoinV1::Miter)
    );
    assert_eq!(
        sample_stroke(2.0),
        (StrokeCapV1::Round, StrokeJoinV1::Bevel)
    );
}

#[test]
fn stroke_style_keyframes_keep_base_and_miter_limit_constraints() {
    for mutate_first in [
        |stroke: &mut StrokeStyleV1| stroke.cap = StrokeCapV1::Round,
        |stroke: &mut StrokeStyleV1| stroke.join = StrokeJoinV1::Bevel,
    ] {
        let (_, mut bundle) = fixture();
        let AnimationChannelV1::VectorAppearance { keyframes, .. } =
            &mut bundle.scene.animation_channels[1]
        else {
            panic!("fixture appearance channel is missing");
        };
        mutate_first(keyframes[0].value.stroke.as_mut().unwrap());
        assert!(
            validate_scene_ir_v1(&bundle.scene)
                .unwrap_err()
                .contains_message("stroke cap, join, or miter-limit styles")
        );
    }

    let (_, mut bundle) = fixture();
    let AnimationChannelV1::VectorAppearance { keyframes, .. } =
        &mut bundle.scene.animation_channels[1]
    else {
        panic!("fixture appearance channel is missing");
    };
    keyframes[1].value.stroke.as_mut().unwrap().miter_limit = 4.0;
    assert!(
        validate_scene_ir_v1(&bundle.scene)
            .unwrap_err()
            .contains_message("miter-limit styles")
    );
}

#[test]
fn animated_zero_width_is_normalized_without_weakening_static_strokes() {
    let (fixture, bundle) = fixture();

    let mut static_zero = bundle.scene.clone();
    let poietra_scene_ir::SceneAppearanceV1::Vector {
        stroke: Some(stroke),
        ..
    } = &mut static_zero.entities[0].appearance
    else {
        panic!("fixture static stroke is missing");
    };
    stroke.width_world = 0.0;
    assert!(
        validate_scene_ir_v1(&static_zero)
            .unwrap_err()
            .contains_message("must be positive")
    );

    let mut zero_bundle = bundle;
    let AnimationChannelV1::VectorAppearance { keyframes, .. } =
        &mut zero_bundle.scene.animation_channels[1]
    else {
        panic!("fixture appearance channel is missing");
    };
    keyframes[1].value.stroke.as_mut().unwrap().width_world = 0.0;
    validate_scene_ir_v1(&zero_bundle.scene).unwrap();
    let session = EngineSessionV1::new(zero_bundle).unwrap();

    let sample = |sample_time| {
        session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "appearance:zero",
                sample_time,
                viewport: fixture.viewport.clone(),
            })
            .unwrap()
    };
    let midpoint = sample(1.5);
    let RenderDrawV1::Path {
        fill: Some(_),
        stroke: Some(stroke),
        ..
    } = &midpoint.draws[0]
    else {
        panic!("positive midpoint must retain its stroke");
    };
    assert_close(stroke.width_world, 0.02);

    let endpoint = sample(2.0);
    assert!(matches!(
        &endpoint.draws[0],
        RenderDrawV1::Path {
            fill: Some(_),
            stroke: None,
            ..
        }
    ));
}

#[test]
fn contract_rejects_negative_and_non_finite_animated_stroke_widths() {
    for width_world in [-0.01, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let (_, mut bundle) = fixture();
        let AnimationChannelV1::VectorAppearance { keyframes, .. } =
            &mut bundle.scene.animation_channels[1]
        else {
            panic!("fixture appearance channel is missing");
        };
        keyframes[1].value.stroke.as_mut().unwrap().width_world = width_world;
        assert!(validate_scene_ir_v1(&bundle.scene).is_err());
    }
}
