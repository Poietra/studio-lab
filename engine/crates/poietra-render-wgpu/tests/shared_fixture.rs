use std::fs;
use std::path::PathBuf;

use poietra_eval::{CompileEngineFrameOptionsV1, compile_engine_frame_v1};
use poietra_render_wgpu::{PrepareFrameErrorV1, UnsupportedDrawReasonV1, prepare_frame_v1};
use poietra_scene_ir::{AssetManifestV1, RenderDrawV1, SceneIrV1, ViewportV1};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedFixture {
    assets: AssetManifestV1,
    sample: EvaluationRequest,
    scene: SceneIrV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvaluationRequest {
    evidence: Vec<String>,
    packet_id: String,
    sample_time: f64,
    viewport: ViewportV1,
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/engine-v1/shared-circle-opacity.json")
}

fn sampled_packet() -> poietra_scene_ir::RenderPacketV1 {
    let fixture: SharedFixture =
        serde_json::from_slice(&fs::read(fixture_path()).expect("shared fixture must be readable"))
            .expect("shared fixture must match its envelope");
    compile_engine_frame_v1(CompileEngineFrameOptionsV1 {
        assets: &fixture.assets,
        evidence: &fixture.sample.evidence,
        packet_id: &fixture.sample.packet_id,
        sample_time: fixture.sample.sample_time,
        scene: &fixture.scene,
        viewport: fixture.sample.viewport,
    })
    .expect("shared fixture must evaluate")
    .packet
}

fn assert_close(actual: f32, expected: f32) {
    assert!(
        (actual - expected).abs() <= 1.0e-6,
        "expected {expected}, received {actual}"
    );
}

fn assert_color_close(actual: [f32; 4], expected: [f32; 4]) {
    for (actual, expected) in actual.into_iter().zip(expected) {
        assert_close(actual, expected);
    }
}

#[test]
fn prepares_shared_fixture_as_ordered_convex_fill_triangles() {
    let prepared = prepare_frame_v1(&sampled_packet()).expect("shared fixture must prepare");
    assert_eq!(prepared.viewport(), [160, 90]);
    for (actual, expected) in prepared.clear_color().into_iter().zip([0.0, 0.0, 0.0, 1.0]) {
        assert!((actual - expected).abs() <= f64::EPSILON);
    }
    assert_eq!(prepared.draws()[0].draw_id(), "draw:0");
    let first_index_end = prepared.draws()[0].index_range().end;
    let first_vertices =
        usize::try_from(first_index_end / 3 + 2).expect("fixture vertices must fit usize");
    assert_eq!(prepared.draws()[0].index_range(), &(0..first_index_end));
    assert_eq!(prepared.draws()[1].draw_id(), "draw:1");
    assert_eq!(prepared.draws()[1].index_range().start, first_index_end);
    let second_indices = prepared.draws()[1].index_range().len();
    let second_vertices = second_indices / 3 + 2;
    assert_eq!(prepared.vertices().len(), first_vertices + second_vertices);
    assert_eq!(
        prepared.indices().len(),
        usize::try_from(prepared.draws()[1].index_range().end).unwrap()
    );

    let first = prepared.vertices()[0];
    assert_close(first.position()[0], 0.0);
    assert_close(first.position()[1], 0.0);
    assert_color_close(first.premultiplied_linear_color(), [0.5, 0.0, 0.0, 0.5]);
    let later = prepared.vertices()[first_vertices];
    assert_close(later.position()[0], 0.1875);
    assert_close(later.position()[1], 0.0);
    assert_color_close(later.premultiplied_linear_color(), [0.0, 0.0, 1.0, 1.0]);
}

#[test]
fn one_unsupported_draw_rejects_the_complete_packet() {
    let mut packet = sampled_packet();
    let RenderDrawV1::Path { fill, stroke, .. } = &mut packet.draws[1] else {
        panic!("fixture draw must be a path");
    };
    let color = fill
        .as_ref()
        .expect("fixture path must have a fill")
        .color
        .clone();
    *stroke = Some(poietra_scene_ir::StrokeStyleV1 {
        cap: poietra_scene_ir::StrokeCapV1::Butt,
        color,
        join: poietra_scene_ir::StrokeJoinV1::Miter,
        miter_limit: 4.0,
        width_world: 0.1,
    });
    packet.required_capabilities = vec![
        poietra_scene_ir::RenderCapabilityV1::CubicPathFill,
        poietra_scene_ir::RenderCapabilityV1::CubicPathStroke,
    ];

    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::Unsupported {
            reason: UnsupportedDrawReasonV1::Stroke,
            ..
        })
    ));
}

#[test]
fn transformed_coordinates_must_fit_f32_before_preparation_succeeds() {
    let mut packet = sampled_packet();
    let RenderDrawV1::Path { transform, .. } = &mut packet.draws[0] else {
        panic!("fixture draw must be a path");
    };
    transform.m11 = f64::MAX;

    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::NumericRange { .. })
    ));
}
