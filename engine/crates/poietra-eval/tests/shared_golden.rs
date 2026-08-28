use std::fs;
use std::path::PathBuf;

use poietra_eval::{CompileEngineFrameOptionsV1, compile_engine_frame_v1};
use poietra_scene_ir::{
    AssetManifestV1, RenderDrawV1, SceneIrBundleV1, SceneIrV1, ViewportV1,
    validate_scene_ir_bundle_v1,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedFixture {
    assets: AssetManifestV1,
    expected: Expected,
    id: String,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expected {
    camera: ExpectedCamera,
    draw_entity_ids: Vec<String>,
    draw_kinds: Vec<String>,
    opacities: Vec<f64>,
    path_segment_counts: Vec<usize>,
    required_capabilities: Vec<String>,
    tolerance: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectedCamera {
    bottom: f64,
    left: f64,
    right: f64,
    top: f64,
}

/// Stable Scene IR fixtures pin the canonical Rust evaluator independently of
/// browser delivery through the WASM adapter.
const SHARED_FIXTURE_FILES: [&str; 2] = [
    "shared-circle-opacity.json",
    "shared-near-singular-affine.json",
];

fn fixture_path(file_name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/engine-v1")
        .join(file_name)
}

fn assert_close(actual: f64, expected: f64, tolerance: f64, label: &str) {
    assert!(
        (actual - expected).abs() <= tolerance * expected.abs().max(1.0),
        "{label}: expected {expected}, received {actual}"
    );
}

#[test]
fn parses_and_evaluates_scene_ir_golden_fixtures() {
    for file_name in SHARED_FIXTURE_FILES {
        parses_and_evaluates_shared_fixture(file_name);
    }
}

fn parses_and_evaluates_shared_fixture(file_name: &str) {
    let fixture_bytes =
        fs::read(fixture_path(file_name)).expect("shared golden fixture must be readable");
    let fixture: SharedFixture = serde_json::from_slice(&fixture_bytes)
        .expect("shared golden fixture must match its envelope");
    validate_scene_ir_bundle_v1(&SceneIrBundleV1 {
        assets: fixture.assets.clone(),
        scene: fixture.scene.clone(),
    })
    .unwrap_or_else(|error| panic!("{} input is invalid: {error}", fixture.id));

    let frame = compile_engine_frame_v1(CompileEngineFrameOptionsV1 {
        assets: &fixture.assets,
        evidence: &fixture.sample.evidence,
        packet_id: &fixture.sample.packet_id,
        sample_time: fixture.sample.sample_time,
        scene: &fixture.scene,
        viewport: fixture.sample.viewport,
    })
    .unwrap_or_else(|error| panic!("{} evaluation failed: {error}", fixture.id));

    let entity_ids: Vec<_> = frame
        .packet
        .draws
        .iter()
        .map(RenderDrawV1::entity_id)
        .collect();
    assert_eq!(entity_ids, fixture.expected.draw_entity_ids);
    let draw_kinds: Vec<_> = frame
        .packet
        .draws
        .iter()
        .map(|draw| match draw {
            RenderDrawV1::Empty { .. } => "empty",
            RenderDrawV1::Image { .. } => "image",
            RenderDrawV1::Path { .. } => "path",
        })
        .collect();
    assert_eq!(draw_kinds, fixture.expected.draw_kinds);
    let segment_counts: Vec<_> = frame
        .packet
        .draws
        .iter()
        .map(|draw| match draw {
            RenderDrawV1::Empty { .. } | RenderDrawV1::Image { .. } => 0,
            RenderDrawV1::Path { path, .. } => path
                .subpaths
                .iter()
                .map(|subpath| subpath.segments.len())
                .sum(),
        })
        .collect();
    assert_eq!(segment_counts, fixture.expected.path_segment_counts);
    let capabilities: Vec<_> = frame
        .packet
        .required_capabilities
        .iter()
        .map(|capability| match capability {
            poietra_scene_ir::RenderCapabilityV1::CubicPathFill => "cubic-path-fill",
            poietra_scene_ir::RenderCapabilityV1::CubicPathStroke => "cubic-path-stroke",
            poietra_scene_ir::RenderCapabilityV1::FragmentMaterial => "fragment-material",
            poietra_scene_ir::RenderCapabilityV1::PngImage => "png-image",
            poietra_scene_ir::RenderCapabilityV1::ScenePostEffect => "scene-post-effect",
        })
        .collect();
    assert_eq!(capabilities, fixture.expected.required_capabilities);
    for (index, draw) in frame.packet.draws.iter().enumerate() {
        assert_close(
            draw.opacity(),
            fixture.expected.opacities[index],
            fixture.expected.tolerance,
            "opacity",
        );
    }
    assert_close(
        frame.packet.camera.bottom,
        fixture.expected.camera.bottom,
        fixture.expected.tolerance,
        "camera.bottom",
    );
    assert_close(
        frame.packet.camera.left,
        fixture.expected.camera.left,
        fixture.expected.tolerance,
        "camera.left",
    );
    assert_close(
        frame.packet.camera.right,
        fixture.expected.camera.right,
        fixture.expected.tolerance,
        "camera.right",
    );
    assert_close(
        frame.packet.camera.top,
        fixture.expected.camera.top,
        fixture.expected.tolerance,
        "camera.top",
    );
}
